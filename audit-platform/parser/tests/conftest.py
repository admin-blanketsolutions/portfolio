from __future__ import annotations

import io
import zipfile

import openpyxl
import pytest


def xlsx_bytes(rows: list[list[object]], title: str = "TB", extra_sheets: dict[str, str] | None = None) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = title
    for r in rows:
        ws.append(r)
    for name, state in (extra_sheets or {}).items():
        s = wb.create_sheet(name)
        s.append(["Code", "Name", "Balance"])
        s.append(["999", "Hidden trap", 1])
        s.sheet_state = state
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def rezip(data: bytes, add: dict[str, bytes] | None = None, replace: dict[str, bytes] | None = None,
          compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    """Copy an .xlsx, adding or replacing parts (to build hostile variants)."""
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression) as dst:
        for info in src.infolist():
            body = (replace or {}).get(info.filename, src.read(info.filename))
            dst.writestr(info.filename, body)
        for name, body in (add or {}).items():
            dst.writestr(name, body)
    return out.getvalue()


def with_cached_values(data: bytes, sheet_part: str, replacements: dict[str, str]) -> bytes:
    """openpyxl writes formulas without cached values; patch <f>..</f> cells to carry one."""
    src = zipfile.ZipFile(io.BytesIO(data))
    xml = src.read(sheet_part).decode()
    for formula, value in replacements.items():
        xml = xml.replace(f"<f>{formula}</f><v></v>", f"<f>{formula}</f><v>{value}</v>")
        xml = xml.replace(f"<f>{formula}</f><v />", f"<f>{formula}</f><v>{value}</v>")
        xml = xml.replace(f"<f>{formula}</f>", f"<f>{formula}</f><v>{value}</v>") if f"<f>{formula}</f><v>" not in xml else xml
    return rezip(data, replace={sheet_part: xml.encode()})


@pytest.fixture
def simple_rows() -> list[list[object]]:
    return [
        ["Trial balance as at 31 December 2025"],
        [],
        ["Code", "Account name", "Debit", "Credit"],
        [101, "Cash at bank", 100000, None],
        ["120", "ذمم مدينة", 50000.5, None],
        [201, "Suppliers", None, 30000],
        [301, "Paid-in capital", None, 70000.5],
        [None, "Total", 150000.5, 100000.5],
    ]
