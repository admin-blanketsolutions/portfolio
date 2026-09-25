"""CLI used by the ingestion worker:  python -m tb_parser --format xlsx < file > result.json

Exit codes: 0 = parsed (JSON result on stdout), 2 = rejected (JSON {"error": {...}}
on stdout), 1 = internal failure (nothing useful on stdout).

In production this runs in a network-less, read-only, non-root container with
one file per invocation. `--sandbox-limits` additionally applies kernel
resource limits to this process (address space, CPU time, no file writes).
"""

from __future__ import annotations

import argparse
import json
import sys

from . import PARSER_VERSION, parse_bytes
from .errors import ParseError
from .limits import Limits


def _apply_rlimits(memory_mb: int, cpu_seconds: int) -> None:
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024 * 1024, memory_mb * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))    # no regular-file writes (stdout is a pipe)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tb_parser")
    ap.add_argument("--format", required=True, choices=["csv", "xlsx"])
    ap.add_argument("--sheet")
    ap.add_argument("--decimal-separator", choices=[".", ","])
    ap.add_argument("--max-rows", type=int)
    ap.add_argument("--sandbox-limits", action="store_true")
    ap.add_argument("--memory-mb", type=int, default=1024)
    ap.add_argument("--cpu-seconds", type=int, default=60)
    ap.add_argument("--version", action="version", version=PARSER_VERSION)
    args = ap.parse_args(argv)

    if args.sandbox_limits:
        _apply_rlimits(args.memory_mb, args.cpu_seconds)

    limits = Limits() if args.max_rows is None else Limits(max_rows=args.max_rows)
    data = sys.stdin.buffer.read(limits.max_file_bytes + 1)
    try:
        result = parse_bytes(data, args.format, limits=limits, sheet=args.sheet,
                             decimal_separator=args.decimal_separator)
    except ParseError as exc:
        json.dump({"error": exc.to_dict(), "parser_version": PARSER_VERSION}, sys.stdout, ensure_ascii=False)
        return 2
    except MemoryError:
        json.dump({"error": {"code": "resource_limit", "message": "The file needs more memory than permitted."},
                   "parser_version": PARSER_VERSION}, sys.stdout)
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
