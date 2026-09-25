from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    """Resource ceilings. Every one of them is enforced before or while the
    corresponding work is done, never after, so a hostile file fails fast."""

    max_file_bytes: int = 25 * 1024 * 1024
    # OOXML is a ZIP: bound what it may expand to (zip bombs).
    max_uncompressed_bytes: int = 200 * 1024 * 1024
    max_compression_ratio: float = 100.0
    max_zip_entries: int = 2_000
    # Sheet shape. 1M-row / 16K-column sparse sheets are a DoS vector.
    max_rows: int = 100_000
    max_cols: int = 64
    max_cell_chars: int = 1_024
    header_scan_rows: int = 30
    # Warnings carry at most this many example row numbers each.
    max_warning_rows: int = 20
