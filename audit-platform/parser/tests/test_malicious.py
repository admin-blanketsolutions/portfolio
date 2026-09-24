"""Hostile-workbook corpus (docs/01 section 3.1). Each must be refused, fast, with a stable code."""

import io
import json
import subprocess
import sys
import time
import zipfile

import pytest

from tb_parser import ParseError, parse_bytes
from tb_parser.limits import Limits

from .conftest import rezip, xlsx_bytes

BASE = [["Code", "Name", "Balance"], ["1", "Cash", 1], ["2", "Equity", -1]]


def refused(data: bytes, code: str, limits: Limits = Limits()) -> None:
    started = time.monotonic()
    with pytest.raises(ParseError) as exc:
        parse_bytes(data, "xlsx", limits=limits)
    assert exc.value.code == code, exc.value.message
    assert time.monotonic() - started < 5


def test_vba_project_part():
    refused(rezip(xlsx_bytes(BASE), add={"xl/vbaProject.bin": b"\xd0\xcf\x11\xe0 fake ole"}), "active_content")


def test_macro_enabled_content_type():
    data = xlsx_bytes(BASE)
    ct = zipfile.ZipFile(io.BytesIO(data)).read("[Content_Types].xml").replace(
        b"spreadsheetml.sheet.main+xml", b"sheet.macroEnabled.main+xml")
    refused(rezip(data, replace={"[Content_Types].xml": ct}), "active_content")


@pytest.mark.parametrize("part", ["xl/macrosheets/sheet1.xml", "xl/externalLinks/externalLink1.xml",
                                  "xl/activeX/activeX1.xml", "xl/embeddings/oleObject1.bin",
                                  "xl/connections.xml", "customUI/customUI.xml"])
def test_active_or_linked_parts(part):
    refused(rezip(xlsx_bytes(BASE), add={part: b"<x/>"}), "active_content")


def test_printer_settings_blob_is_allowed():
    data = rezip(xlsx_bytes(BASE), add={"xl/printerSettings/printerSettings1.bin": b"\x00" * 64})
    assert parse_bytes(data, "xlsx")["control"]["line_count"] == 2


def test_xxe_and_billion_laughs_dtd():
    xxe = (b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'
           b'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&e;</t></si></sst>')
    refused(rezip(xlsx_bytes(BASE), add={"xl/sharedStrings.xml": xxe}), "malformed")
    lol = b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><r>&lol2;</r>'
    refused(rezip(xlsx_bytes(BASE), add={"docProps/custom.xml": lol}), "malformed")


def test_zip_bomb_by_total_size():
    bomb = b"<a>" + b" " * (30 * 1024 * 1024) + b"</a>"
    refused(rezip(xlsx_bytes(BASE), add={"xl/bomb.xml": bomb}), "zip_bomb",
            Limits(max_uncompressed_bytes=20 * 1024 * 1024))


def test_zip_bomb_by_ratio():
    bomb = b"<a>" + b"0" * (8 * 1024 * 1024) + b"</a>"
    refused(rezip(xlsx_bytes(BASE), add={"xl/bomb.xml": bomb}), "zip_bomb")


def test_too_many_parts():
    add = {f"docProps/x{i}.xml": b"<x/>" for i in range(30)}
    refused(rezip(xlsx_bytes(BASE), add=add), "zip_bomb", Limits(max_zip_entries=20))


@pytest.mark.parametrize("name", ["../evil.xml", "/abs.xml", "xl\\win.xml", "C:evil.xml"])
def test_unsafe_part_names(name):
    refused(rezip(xlsx_bytes(BASE), add={name: b"<x/>"}), "malformed")


def test_not_a_zip_and_corrupt_zip():
    refused(b"%PDF-1.7 not a workbook", "unsupported_format")
    refused(b"PK\x03\x04" + b"\x00" * 100, "malformed")


def test_ole_compound_file_xls_is_refused():
    refused(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512, "unsupported_format")


def test_sparse_giant_sheet_hits_row_limit_quickly():
    data = xlsx_bytes(BASE)
    zf = zipfile.ZipFile(io.BytesIO(data))
    xml = zf.read("xl/worksheets/sheet1.xml").decode()
    # A single cell a million rows down plus a dimension claiming the whole grid.
    xml = xml.replace("</sheetData>", '<row r="1048576"><c r="XFD1048576" t="n"><v>1</v></c></row></sheetData>')
    xml = xml.replace('<dimension ref="A1:C3" />', '<dimension ref="A1:XFD1048576" />')
    refused(rezip(data, replace={"xl/worksheets/sheet1.xml": xml.encode()}), "too_many_rows", Limits(max_rows=5_000))


def test_cli_rejection_is_json_with_exit_code_2():
    data = rezip(xlsx_bytes(BASE), add={"xl/vbaProject.bin": b"x"})
    p = subprocess.run([sys.executable, "-m", "tb_parser", "--format", "xlsx", "--sandbox-limits"],
                       input=data, capture_output=True, timeout=30)
    assert p.returncode == 2
    assert json.loads(p.stdout)["error"]["code"] == "active_content"


def test_cli_success_under_sandbox_limits():
    p = subprocess.run([sys.executable, "-m", "tb_parser", "--format", "xlsx", "--sandbox-limits"],
                       input=xlsx_bytes(BASE), capture_output=True, timeout=30)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out["control"]["line_count"] == 2 and out["parser_version"].startswith("tb-parser@")
