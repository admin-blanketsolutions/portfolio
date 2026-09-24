import { spawn } from 'node:child_process';
import { ParseRejectionSchema, ParseResultSchema, TbParseRejected, type ParseResult, type TbParseRequest, type TbParserPort } from './parser-port.js';

export interface SubprocessParserOptions {
  /** Python interpreter with the parser's requirements installed. */
  python: string;
  /** Directory containing the tb_parser package (parser/). */
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryMb?: number;
}

/**
 * Development / single-host adapter: one short-lived process per file, with
 * kernel resource limits (--sandbox-limits) and an empty environment (no
 * credentials, no proxy settings). Production runs the same CLI in a
 * network-less, read-only, non-root container (see docs/01 section 3.2); only
 * this adapter changes.
 */
export class SubprocessTbParser implements TbParserPort {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(private readonly opts: SubprocessParserOptions) {
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 256 * 1024 * 1024;
  }

  parse(req: TbParseRequest): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
      const args = ['-E', '-s', '-m', 'tb_parser', '--format', req.format, '--sandbox-limits',
        '--memory-mb', String(this.opts.memoryMb ?? 1536), '--cpu-seconds', String(Math.ceil(this.timeoutMs / 1000))];
      const child = spawn(this.opts.python, args, {
        cwd: this.opts.cwd,
        // -E ignores PYTHON* variables, -s the user site-packages; the module is
        // found via cwd. Nothing from our environment (credentials!) is inherited.
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let outBytes = 0;
      let errTail = '';
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new TbParseRejected('timeout', 'The file took too long to process.')));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > this.maxOutputBytes) {
          child.kill('SIGKILL');
          finish(() => reject(new Error('parser output exceeded the limit')));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { errTail = (errTail + chunk.toString('utf8')).slice(-2000); });
      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', (code) => finish(() => {
        const text = Buffer.concat(out).toString('utf8');
        try {
          if (code === 0) {
            const parsed = ParseResultSchema.safeParse(JSON.parse(text));
            if (!parsed.success) throw new Error('parser produced an invalid result');
            resolve(parsed.data);
          } else if (code === 2) {
            const rej = ParseRejectionSchema.safeParse(JSON.parse(text));
            if (!rej.success) throw new Error('parser produced an invalid rejection');
            reject(new TbParseRejected(rej.data.error.code, rej.data.error.message, rej.data.error.row));
          } else {
            // Killed by a resource limit (SIGXCPU / MemoryError abort) or crashed.
            reject(code === null
              ? new TbParseRejected('resource_limit', 'The file needs more resources than permitted.')
              : new Error(`parser exited with ${code}: ${errTail.slice(-300)}`));
          }
        } catch (err) {
          reject(err);
        }
      }));

      child.stdin.on('error', () => { /* child exited early (e.g. rejected the size); handled on close */ });
      child.stdin.end(Buffer.from(req.bytes));
    });
  }
}
