"""Text hygiene for client-supplied account codes and names.

Two outputs, kept deliberately separate:

* ``clean_display`` — what auditors see and sign. The characters are the
  client's, minus the invisible ones that let a string *render* differently
  from its bytes (bidi embeddings/overrides/isolates, directional marks,
  zero-width characters, control characters). Nothing else is changed.

* ``normalize_for_matching`` — used only to compare names (mapping cascade).
  NFKC (folds Arabic presentation forms and full-width Latin), case-folding,
  ASCII digits, Arabic orthographic folding (alef/yaa/taa-marbuta/hamza
  carriers, tashkeel, tatweel), punctuation to spaces.

The TypeScript port (backend/src/modules/tb-ingestion/normalize.ts) must agree
byte-for-byte; both are tested against tests/golden/normalization.json.
"""

from __future__ import annotations

import re
import unicodedata

# Characters that change how text is displayed without being visible.
_INVISIBLE = {
    0x061C,  # ARABIC LETTER MARK
    0x200B,  # ZERO WIDTH SPACE
    0x200E, 0x200F,  # LRM, RLM
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E,  # LRE, RLE, PDF, LRO, RLO
    0x2060,  # WORD JOINER
    0x2066, 0x2067, 0x2068, 0x2069,  # LRI, RLI, FSI, PDI
    0xFEFF,  # BOM / ZWNBSP
    0x00AD,  # SOFT HYPHEN
}
_ZW_JOINERS = {0x200C, 0x200D}  # meaningful in some scripts: kept for display only

_WS = re.compile(r"\s+", re.UNICODE)

_ARABIC_FOLD = {
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
    "ٲ": "ا", "ٳ": "ا",           # alef variants -> alef
    "ى": "ي", "ی": "ي", "ئ": "ي",  # alef maqsura, farsi yeh, yeh+hamza -> yeh
    "ؤ": "و",                               # waw+hamza -> waw
    "ة": "ه",                               # taa marbuta -> heh
    "ک": "ك",                               # keheh -> kaf
}


def _is_tashkeel(cp: int) -> bool:
    return 0x064B <= cp <= 0x065F or cp == 0x0670 or 0x06D6 <= cp <= 0x06ED


def clean_display(text: str) -> tuple[str, bool]:
    """Return (cleaned text, whether invisible characters were removed)."""
    out: list[str] = []
    removed = False
    for ch in text:
        cp = ord(ch)
        if cp in _INVISIBLE:
            removed = True
            continue
        cat = unicodedata.category(ch)
        if cat == "Cc":  # C0/C1 controls: tab/newline become spaces, the rest go
            if ch in "\t\n\r\v\f":
                out.append(" ")
            else:
                removed = True
            continue
        if cat in ("Zl", "Zp"):
            out.append(" ")
            continue
        out.append(ch)
    return _WS.sub(" ", "".join(out)).strip(), removed


def ascii_digits(text: str) -> str:
    """Map every Unicode decimal digit (Arabic-Indic, Eastern Arabic-Indic, ...) to ASCII."""
    return "".join(str(unicodedata.decimal(ch)) if unicodedata.category(ch) == "Nd" else ch for ch in text)


def normalize_for_matching(text: str) -> str:
    cleaned, _ = clean_display(text)
    s = unicodedata.normalize("NFKC", cleaned).casefold()
    s = ascii_digits(s)
    out: list[str] = []
    for ch in s:
        cp = ord(ch)
        if _is_tashkeel(cp) or cp == 0x0640 or cp in _ZW_JOINERS:  # harakat, tatweel, ZWNJ/ZWJ
            continue
        ch = _ARABIC_FOLD.get(ch, ch)
        cat = unicodedata.category(ch)
        out.append(ch if cat[0] in ("L", "N") else " ")
    return _WS.sub(" ", "".join(out)).strip()


# Cells beginning with these execute as formulas when a CSV/XLSX export is
# opened in a spreadsheet (OWASP CSV injection).
FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")


def looks_like_formula(text: str) -> bool:
    return text.startswith(FORMULA_TRIGGERS) and not _is_plain_negative_number(text)


_NEG_NUMBER = re.compile(r"^[-+]\s*[\d.,٠-٩۰-۹٫٬]+$")


def _is_plain_negative_number(text: str) -> bool:
    return bool(_NEG_NUMBER.match(text))
