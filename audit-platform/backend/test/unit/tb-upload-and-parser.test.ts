import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/common/errors.js';
import { InProcessJobQueue } from '../../src/jobs/job-queue.js';
import { TbParseRejected } from '../../src/modules/tb-ingestion/parser-port.js';
import { SubprocessTbParser } from '../../src/modules/tb-ingestion/subprocess-parser.js';
import { assertMagic, formatFromFilename, readBody, sanitizeFilename } from '../../src/modules/tb-ingestion/upload.js';
import { InMemoryObjectStore } from '../../src/storage/in-memory-object-store.js';
import { currentTenantContext, runWithTenantContext } from '../../src/tenancy/tenant-context.js';
import { TENANT_A, USER_A, ctx } from './fixtures.js';

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: DomainError) => e.code);

function request(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([body.subarray(0, 3), body.subarray(3)]) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = headers;
  return r;
}

describe('upload validation', () => {
  it('keeps only a clean base name and never trusts extensions alone', () => {
    expect(sanitizeFilename('C:\\Users\\x\\..\\TB\u202E 2025.xlsx')).toBe('TB 2025.xlsx');
    expect(sanitizeFilename('../../etc/passwd.csv')).toBe('passwd.csv');
    expect(() => sanitizeFilename('..')).toThrow(DomainError);
    expect(formatFromFilename('TB.XLSX')).toBe('xlsx');
    for (const bad of ['TB.xlsm', 'TB.xls', 'TB.xlsb', 'TB.pdf', 'TB']) {
      expect(() => formatFromFilename(bad)).toThrow(/Only .xlsx and .csv/);
    }
    expect(() => assertMagic(Buffer.from('Code,Name\n'), 'xlsx')).toThrow(/not an .xlsx/);
    expect(() => assertMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'csv')).toThrow(/workbook, not a CSV/);
    expect(() => assertMagic(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'csv')).toThrow();
  });

  it('enforces the byte limit on declared and streamed sizes', async () => {
    expect(await code(readBody(request(Buffer.alloc(10), { 'content-length': '999' }), 100))).toBe('payload_too_large');
    expect(await code(readBody(request(Buffer.alloc(101)), 100))).toBe('payload_too_large');
    expect((await readBody(request(Buffer.from('abcdef')), 100)).toString()).toBe('abcdef');
  });
});

describe('in-memory object store keeps S3 semantics', () => {
  it('rejects bad checksums and overwrites of locked objects', async () => {
    const s = new InMemoryObjectStore();
    const req = { Bucket: 'b', Key: 'k', Body: new Uint8Array([1]), ContentType: 'x', ChecksumSHA256: 'wrong',
      ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: 'k', BucketKeyEnabled: true as const,
      ObjectLockMode: 'COMPLIANCE' as const, ObjectLockRetainUntilDate: new Date(), Tagging: '' };
    await expect(s.putObject(req)).rejects.toThrow(/BadDigest/);
    const ok = { ...req, ChecksumSHA256: createHash('sha256').update(req.Body).digest('base64') };
    await s.putObject(ok);
    await expect(s.putObject(ok)).rejects.toThrow(/Object Lock/);
    expect(await s.getObject('b', 'k')).toEqual(new Uint8Array([1]));
  });
});

describe('in-process job queue', () => {
  it('starts handlers outside the enqueueing request\'s tenant context', async () => {
    const q = new InProcessJobQueue();
    const seen: unknown[] = [];
    q.register('t', async () => { seen.push(currentTenantContext()); });
    await runWithTenantContext(ctx(TENANT_A, USER_A), () => q.enqueue({ type: 't' } as never));
    await q.drain();
    expect(seen).toEqual([undefined]);
  });
});

describe('subprocess parser adapter', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tbp-'));
  const fake = (name: string, script: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, `#!/bin/sh\ncat > /dev/null\n${script}\n`);
    chmodSync(p, 0o755);
    return new SubprocessTbParser({ python: p, cwd: dir, timeoutMs: 2_000 });
  };
  const req = { bytes: Buffer.from('Code,Name,Balance\n'), format: 'csv' as const };

  it('turns exit code 2 into a user-facing rejection and passes no environment through', async () => {
    process.env['SECRET_FOR_TEST'] = 'leak-me';
    const p = fake('reject.sh', 'printf \'{"error":{"code":"bad_amount","message":"x%sx","row":3}}\' "$SECRET_FOR_TEST"; exit 2');
    const err = await p.parse(req).catch((e: TbParseRejected) => e);
    expect(err).toBeInstanceOf(TbParseRejected);
    expect(err).toMatchObject({ code: 'bad_amount', message: 'xx', row: 3 });
  });

  it('refuses output that does not match the contract', async () => {
    const bad = fake('bad.sh', 'echo \'{"parser_version":"tb-parser@1","lines":[]}\'');
    await expect(bad.parse(req)).rejects.toThrow(/invalid result/);
    const lies = fake('lies.sh', `echo '${JSON.stringify({
      parser_version: 'tb-parser@1', format: 'csv', sheet: null, header_row: 1, layout: 'closing_signed', columns: { code: 'A' },
      lines: [{ line_no: 1, source_row: 2, code: '1', name: 'x', name_norm: 'x', opening: null, period_debit: null,
                period_credit: null, closing: '1.0000', had_formula: false }],
      control: { line_count: 2, sum_debit: '1.0000', sum_credit: '0.0000', net: '1.0000' }, warnings: [] })}'`);
    await expect(lies.parse(req)).rejects.toThrow(/invalid result/);   // line_count disagrees with lines
  });

  it('kills a parser that runs past its time limit', async () => {
    const slow = fake('slow.sh', 'sleep 10');
    const err = await slow.parse(req).catch((e: TbParseRejected) => e);
    expect(err).toMatchObject({ code: 'timeout' });
  });

  const venv = path.resolve('../parser/.venv/bin/python');
  it.skipIf(!existsSync(venv))('runs the real sandboxed parser end to end', async () => {
    const real = new SubprocessTbParser({ python: venv, cwd: path.resolve('../parser') });
    const r = await real.parse({ bytes: Buffer.from('Code,Name,Debit,Credit\n101,Cash,100,\n301,Capital,,100\n'), format: 'csv' });
    expect(r.control).toEqual({ line_count: 2, sum_debit: '100.0000', sum_credit: '100.0000', net: '0.0000' });
    const rej = await real.parse({ bytes: Buffer.from('PK\u0003\u0004junk'), format: 'xlsx' }).catch((e: TbParseRejected) => e);
    expect(rej).toMatchObject({ code: 'malformed' });
  });
});
