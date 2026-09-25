import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ContainerTbParser } from '../../src/modules/tb-ingestion/container-parser.js';
import { TbParseRejected, type TbParseRequest } from '../../src/modules/tb-ingestion/parser-port.js';

/**
 * Runs when TB_PARSER_IMAGE names a locally built parser image:
 *   docker build -t audit-tb-parser:test ../parser
 *   TB_PARSER_IMAGE=audit-tb-parser:test npx vitest run test/integration/container-parser.test.ts
 * The isolation tests execute probes with EXACTLY the flags the adapter uses.
 */
const IMAGE = process.env['TB_PARSER_IMAGE'] ?? '';
const run = promisify(execFile);
const PY = '/opt/venv/bin/python';

/** Same isolation flags, a different program: proves what the flags allow, not what the parser happens to do. */
class ProbeParser extends ContainerTbParser {
  constructor(private readonly program: string, opts: Partial<ConstructorParameters<typeof ContainerTbParser>[0]> = {}) {
    super({ image: IMAGE, timeoutMs: 20_000, ...opts });
  }
  protected override commandArgs(): string[] {
    return ['--entrypoint', PY, IMAGE, '-I', '-c', this.program];
  }
}

async function probe(program: string, opts: Partial<ConstructorParameters<typeof ContainerTbParser>[0]> = {}) {
  const inv = new ProbeParser(program, opts).invocation({ bytes: new Uint8Array(), format: 'csv' });
  // A canary in the worker's own environment must not reach the container.
  const { stdout } = await run(inv.command, inv.args, { env: { ...inv.env, CANARY_SECRET: 'must-not-leak' }, timeout: 30_000 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

const CSV: TbParseRequest = {
  format: 'csv',
  bytes: new Uint8Array(Buffer.from('Code,Account name,Debit,Credit\n101,Cash at bank,99500,\n401,Sales,,99500\n')),
};

describe.skipIf(IMAGE === '')('parser in a network-less container', () => {
  const parser = new ContainerTbParser({ image: IMAGE, timeoutMs: 30_000 });

  it('parses a CSV with exact totals', async () => {
    const r = await parser.parse(CSV);
    expect(r.lines.map((l) => [l.code, l.closing])).toEqual([['101', '99500.0000'], ['401', '-99500.0000']]);
    expect(r.control).toMatchObject({ line_count: 2, sum_debit: '99500.0000', sum_credit: '99500.0000' });
  });

  it('parses an xlsx workbook (built by the image\'s own openpyxl, offline)', async () => {
    const make = [
      'import io, sys, openpyxl',
      'wb = openpyxl.Workbook(); ws = wb.active',
      "ws.append(['رقم الحساب', 'اسم الحساب', 'مدين', 'دائن']); ws.append(['101', 'النقد', 150, None]); ws.append(['201', 'ذمم دائنة', None, 150])",
      'b = io.BytesIO(); wb.save(b); sys.stdout.buffer.write(b.getvalue())',
    ].join('\n');
    const xlsx = execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', PY, IMAGE, '-I', '-c', make]);
    const r = await parser.parse({ format: 'xlsx', bytes: new Uint8Array(xlsx) });
    expect(r.format).toBe('xlsx');
    expect(r.lines.map((l) => [l.code, l.name, l.closing])).toEqual([['101', 'النقد', '150.0000'], ['201', 'ذمم دائنة', '-150.0000']]);
  });

  it('turns a parser rejection into a user-fixable error', async () => {
    const err = await parser.parse({ format: 'csv', bytes: new Uint8Array(Buffer.from('foo,bar\n1,2\n')) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TbParseRejected);
    expect((err as TbParseRejected).code).toBe('header_not_found');
  });

  it('gives the parser no network, no writable root, no capabilities, no privileges and no secrets', async () => {
    const p = await probe(`
import json, os, socket
def attempt(fn):
    try:
        fn(); return 'allowed'
    except Exception as e:
        return type(e).__name__
status = dict(l.split(':', 1) for l in open('/proc/self/status').read().splitlines() if ':' in l)
def connect():
    socket.create_connection(('1.1.1.1', 53), timeout=2)
def resolve():
    socket.getaddrinfo('pypi.org', 443)
def write_root():
    open('/opt/venv/pwned', 'w').write('x')
def exec_tmp():
    open('/tmp/x', 'w').write('#!/bin/sh\\n'); os.chmod('/tmp/x', 0o755); os.execv('/tmp/x', ['/tmp/x'])
print(json.dumps({
  'uid': os.getuid(), 'gid': os.getgid(),
  'interfaces': sorted(os.listdir('/sys/class/net')),
  'connect': attempt(connect), 'dns': attempt(resolve),
  'write_root': attempt(write_root), 'exec_tmp': attempt(exec_tmp),
  'cap_eff': status['CapEff'].strip(), 'cap_bnd': status['CapBnd'].strip(), 'no_new_privs': status['NoNewPrivs'].strip(),
  'env': sorted(os.environ),
}))`);
    expect(p['uid']).toBe(65532);
    expect(p['gid']).toBe(65532);
    expect(p['interfaces']).toEqual(['lo']);
    expect(p['connect']).not.toBe('allowed');
    expect(p['dns']).not.toBe('allowed');
    expect(p['write_root']).toBe('OSError');
    expect(p['exec_tmp']).toBe('PermissionError');
    expect(p['cap_eff']).toBe('0000000000000000');
    expect(p['cap_bnd']).toBe('0000000000000000');   // nothing to regain, even via a setuid binary
    expect(p['no_new_privs']).toBe('1');
    const env = p['env'] as string[];
    expect(env).not.toContain('CANARY_SECRET');
    expect(env.filter((k) => /AWS|ANTHROPIC|DATABASE|SECRET|TOKEN|PASSWORD|PROXY/i.test(k))).toEqual([]);
  });

  it('caps processes, so a fork bomb cannot exhaust the host', async () => {
    const p = await probe(`
import json, os, time
n = 0
try:
    for _ in range(200):
        if os.fork() == 0:
            time.sleep(5); os._exit(0)
        n += 1
except OSError:
    pass
print(json.dumps({'children': n}))`);
    expect(p['children']).toBeLessThan(32);
  });

  it('kills the container when it runs past the time limit', async () => {
    const slow = new ProbeParser('import time; time.sleep(120)', { timeoutMs: 2_000 });
    const before = Date.now();
    const err = await slow.parse(CSV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TbParseRejected);
    expect((err as TbParseRejected).code).toBe('timeout');
    expect(Date.now() - before).toBeLessThan(10_000);
    // The container itself is gone, not just the CLI process.
    let left = '';
    for (let i = 0; i < 20; i++) {
      left = (await run('docker', ['ps', '-aq', '--filter', 'name=tb-parse-'])).stdout.trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(left).toBe('');
  });

  it('reports a memory-limit kill as a resource limit, not a crash', async () => {
    const hog = new ProbeParser("x = bytearray(1024 * 1024 * 1024); print('survived')", { memoryMb: 128 });
    const err = await hog.parse(CSV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TbParseRejected);
    expect((err as TbParseRejected).code).toBe('resource_limit');
  });

  it('never pulls an image at parse time; a missing image is our error, not the uploader\'s', async () => {
    const missing = new ContainerTbParser({ image: 'audit-tb-parser:does-not-exist', timeoutMs: 20_000 });
    const err = await missing.parse(CSV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TbParseRejected);
  });
});
