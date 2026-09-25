"""Pre-flight inspection of an .xlsx container, before any XML parser sees it.

An .xlsx is a ZIP of XML parts. openpyxl (with defusedxml) is reasonably
hardened, but it is not designed to face hostile input: we bound the archive
and refuse every feature a trial balance has no business containing.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

from .errors import ParseError
from .limits import Limits

# Parts that carry executable or linked content. A TB never needs them.
_FORBIDDEN_PREFIXES = (
    "xl/vbaproject",       # VBA macros (.xlsm renamed to .xlsx)
    "xl/macrosheets/",     # Excel 4.0 (XLM) macro sheets
    "xl/dialogsheets/",
    "xl/externallinks/",   # external workbook links and DDE links
    "xl/activex/",
    "xl/embeddings/",      # OLE objects (packager shell tricks)
    "xl/ctrlprops/",       # form controls
    "customui/",           # ribbon callbacks
    "xl/connections.xml",  # data connections (ODBC, web queries)
    "xl/querytables/",
)
_FORBIDDEN_CONTENT_TYPES = (
    "macroenabled",
    "vbaproject",
    "externallink",
    "activex",
    "oleobject",
)
_XML_SUFFIXES = (".xml", ".rels", ".vml")
# Streamed in chunks so a single huge part cannot be read into memory at once.
# zipfile stops each part at its declared size (and checks the CRC), so the
# declared-size total checked above also bounds what is actually inflated.
_CHUNK = 64 * 1024


@dataclass(frozen=True)
class GuardReport:
    entries: int
    uncompressed_bytes: int


def inspect_xlsx(data: bytes, limits: Limits) -> GuardReport:
    if not data.startswith(b"PK\x03\x04"):
        raise ParseError("unsupported_format", "The file is not an .xlsx workbook.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ParseError("malformed", "The workbook archive is corrupt.") from exc

    with zf:
        infos = zf.infolist()
        if len(infos) > limits.max_zip_entries:
            raise ParseError("zip_bomb", "The workbook contains too many parts.")
        total = 0
        names: set[str] = set()
        for info in infos:
            name = info.filename
            lname = name.lower()
            if name.startswith(("/", "\\")) or ".." in name.split("/") or "\\" in name or ":" in name:
                raise ParseError("malformed", "The workbook contains an unsafe part name.")
            if lname in names:
                raise ParseError("malformed", "The workbook contains duplicate part names.")
            names.add(lname)
            if info.flag_bits & 0x1:
                raise ParseError("unsupported_format", "Encrypted workbooks are not supported; remove the password.")
            if lname.startswith(_FORBIDDEN_PREFIXES) or (
                    lname.endswith(".bin") and not lname.startswith("xl/printersettings/")):
                raise ParseError("active_content",
                                 "The workbook contains macros, embedded objects or external links. "
                                 "Save a plain .xlsx copy of the trial balance and upload that.")
            total += info.file_size
            if total > limits.max_uncompressed_bytes:
                raise ParseError("zip_bomb", "The workbook expands beyond the permitted size.")
            if info.compress_size and info.file_size / info.compress_size > limits.max_compression_ratio \
                    and info.file_size > 1024 * 1024:
                raise ParseError("zip_bomb", "The workbook has an abnormal compression ratio.")

        if "[content_types].xml" not in names or "xl/workbook.xml" not in names:
            raise ParseError("unsupported_format", "The file is not an .xlsx workbook.")

        content_types = _read_bounded(zf, _real_name(zf, "[content_types].xml"), limits).lower()
        if any(t in content_types for t in _FORBIDDEN_CONTENT_TYPES):
            raise ParseError("active_content",
                             "The workbook declares macro-enabled or linked content. "
                             "Save a plain .xlsx copy of the trial balance and upload that.")

        # DTDs have no place in OOXML and are the vehicle for XXE and
        # entity-expansion ("billion laughs") attacks. Check every XML part.
        for info in infos:
            if info.filename.lower().endswith(_XML_SUFFIXES):
                _reject_dtd(zf, info, limits)
        return GuardReport(entries=len(infos), uncompressed_bytes=total)


def _real_name(zf: zipfile.ZipFile, lname: str) -> str:
    for info in zf.infolist():
        if info.filename.lower() == lname:
            return info.filename
    raise ParseError("unsupported_format", "The file is not an .xlsx workbook.")


def _read_bounded(zf: zipfile.ZipFile, name: str, limits: Limits) -> str:
    buf = bytearray()
    with zf.open(name) as fh:
        while chunk := fh.read(_CHUNK):
            buf += chunk
            if len(buf) > 4 * 1024 * 1024:
                raise ParseError("zip_bomb", "A workbook part is too large.")
    return buf.decode("utf-8", errors="replace")


def _reject_dtd(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limits: Limits) -> None:
    read = 0
    tail = b""
    with zf.open(info) as fh:
        while chunk := fh.read(_CHUNK):
            read += len(chunk)
            if read > limits.max_uncompressed_bytes:  # declared size lied
                raise ParseError("zip_bomb", "The workbook expands beyond the permitted size.")
            window = (tail + chunk).lower()
            if b"<!doctype" in window or b"<!entity" in window:
                raise ParseError("malformed", "The workbook contains a document type declaration, which is not allowed.")
            tail = chunk[-16:]
