import type { ParseResult, TbParseRequest, TbParserPort } from './parser-port.js';
import { runParserProcess } from './parser-process.js';

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
 * Development / test adapter: one short-lived process per file, with kernel
 * resource limits (--sandbox-limits) and an empty environment (no
 * credentials, no proxy settings). It has the host's network and filesystem,
 * so production uses ContainerTbParser instead (enforced by configuration).
 */
export class SubprocessTbParser implements TbParserPort {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(private readonly opts: SubprocessParserOptions) {
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 256 * 1024 * 1024;
  }

  parse(req: TbParseRequest): Promise<ParseResult> {
    return runParserProcess({
      command: this.opts.python,
      // -E ignores PYTHON* variables, -s the user site-packages; the module is
      // found via cwd. Nothing from our environment (credentials!) is inherited.
      args: ['-E', '-s', '-m', 'tb_parser', '--format', req.format, '--sandbox-limits',
        '--memory-mb', String(this.opts.memoryMb ?? 1536), '--cpu-seconds', String(Math.ceil(this.timeoutMs / 1000))],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      cwd: this.opts.cwd,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    }, req.bytes);
  }
}
