import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ParseResult, TbParseRequest, TbParserPort } from './parser-port.js';
import { runParserProcess } from './parser-process.js';

export interface ContainerParserOptions {
  /** Parser image; production requires a digest reference (name@sha256:...). */
  image: string;
  /** Container CLI (docker or podman; both accept these flags). */
  cli?: string;
  /** OCI runtime, e.g. 'runsc' (gVisor) for a user-space kernel boundary. */
  runtime?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Memory for the parser itself; the container gets a little headroom above it. */
  memoryMb?: number;
  /** Environment for the CLI process only (e.g. DOCKER_HOST); nothing reaches the container. */
  cliEnv?: Record<string, string>;
}

/**
 * Production adapter: every file is parsed in a fresh, single-use container.
 *
 *  - `--network none`: the parser cannot reach anything, so a file that
 *    subverts it cannot exfiltrate data or fetch a second stage.
 *  - Read-only root filesystem, a tiny noexec /tmp, no capabilities,
 *    no-new-privileges, a non-root user from the image, pid/memory/CPU caps.
 *  - No environment variables are passed in (no credentials, no proxies), no
 *    volumes are mounted, and the file arrives on stdin only.
 *  - `--log-driver none`: client data is not copied into container logs.
 *  - On a time-out the container is removed by name, not just the CLI killed.
 *
 * The parser still applies its own rlimits inside (--sandbox-limits), so a
 * misconfigured runtime does not remove every limit at once.
 */
export class ContainerTbParser implements TbParserPort {
  private readonly cli: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly memoryMb: number;

  constructor(private readonly opts: ContainerParserOptions) {
    this.cli = opts.cli ?? 'docker';
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 256 * 1024 * 1024;
    this.memoryMb = opts.memoryMb ?? 1536;
  }

  /** Isolation flags, shared with the tests that prove they hold. */
  isolationArgs(name: string): string[] {
    const containerMb = this.memoryMb + 256;
    return [
      'run', '--rm', '-i', '--name', name,
      '--pull', 'never',
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '32',
      '--memory', `${containerMb}m`, '--memory-swap', `${containerMb}m`,
      '--cpus', '1',
      '--ulimit', 'nofile=64:64',
      '--log-driver', 'none',
      ...(this.opts.runtime ? ['--runtime', this.opts.runtime] : []),
    ];
  }

  protected commandArgs(req: TbParseRequest): string[] {
    return [this.opts.image, '--format', req.format, '--sandbox-limits',
      '--memory-mb', String(this.memoryMb), '--cpu-seconds', String(Math.ceil(this.timeoutMs / 1000))];
  }

  /** The exact CLI invocation for one file (exposed to the isolation tests). */
  invocation(req: TbParseRequest): { command: string; args: string[]; env: Record<string, string>; name: string } {
    const name = `tb-parse-${randomUUID()}`;
    return {
      command: this.cli,
      args: [...this.isolationArgs(name), ...this.commandArgs(req)],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...(this.opts.cliEnv ?? {}) },
      name,
    };
  }

  parse(req: TbParseRequest): Promise<ParseResult> {
    const { command, args, env, name } = this.invocation(req);
    return runParserProcess({
      command,
      args,
      env,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      onTimeout: () => {
        execFile(command, ['rm', '-f', name], { env, timeout: 30_000 }, () => { /* best effort; --rm also cleans up */ });
      },
    }, req.bytes);
  }
}
