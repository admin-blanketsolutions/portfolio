import { spawn } from 'node:child_process';
import { ParseRejectionSchema, ParseResultSchema, TbParseRejected, type ParseResult } from './parser-port.js';

export interface ParserProcessSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Called once when the time limit is hit, after the process itself is killed (e.g. to remove a container). */
  onTimeout?: () => void;
}

/*
 * Exit codes that mean "stopped by a resource limit": SIGKILL (OOM killer or
 * the cgroup memory limit) and SIGXCPU (RLIMIT_CPU), either as a signal on a
 * direct child or as 128+n from a container runtime.
 */
const LIMIT_EXIT_CODES = new Set([128 + 9, 128 + 24]);

/**
 * Runs one parser invocation (stdin = file, stdout = JSON) and classifies the
 * outcome. Shared by the subprocess and container adapters so both treat the
 * parser's output identically: as untrusted, schema-validated data.
 */
export function runParserProcess(spec: ParserProcessSpec, input: Uint8Array): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = '';
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      spec.onTimeout?.();
      finish(() => reject(new TbParseRejected('timeout', 'The file took too long to process.')));
    }, spec.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > spec.maxOutputBytes) {
        child.kill('SIGKILL');
        spec.onTimeout?.();
        finish(() => reject(new Error('parser output exceeded the limit')));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { errTail = (errTail + chunk.toString('utf8')).slice(-2000); });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code, signal) => finish(() => {
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
        } else if (signal !== null || (code !== null && LIMIT_EXIT_CODES.has(code))) {
          reject(new TbParseRejected('resource_limit', 'The file needs more resources than permitted.'));
        } else {
          // Includes container-runtime failures (125-127): ours, not the uploader's.
          reject(new Error(`parser exited with ${code}: ${errTail.slice(-300)}`));
        }
      } catch (err) {
        reject(err);
      }
    }));

    child.stdin.on('error', () => { /* child exited early (e.g. rejected the size); handled on close */ });
    child.stdin.end(Buffer.from(input));
  });
}
