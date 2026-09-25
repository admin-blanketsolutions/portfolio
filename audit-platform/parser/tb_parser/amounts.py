"""Money parsing: exact decimals only, never binary floats in the output.

Accepted text forms (after removing invisible characters and spaces):
  1234.5   1,234.50   1.234,50   (1,234.50)   -1,234.50   1,234.50-
  1,234.50 CR / DR   1,234.50 دائن / مدين   ١٬٢٣٤٫٥٠   JOD 1,234.500
Blank cells, "-", "—" and "–" mean "no amount".

Separator rule when the file does not declare one: if both "," and "." occur,
the right-most is the decimal separator; a single "," followed by exactly three
digits is a thousands separator, otherwise it is the decimal separator;
repeated identical separators are thousands separators.
"""

from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from .errors import ParseError
from .normalize import ascii_digits, clean_display

SCALE = Decimal("0.0001")  # app.money = numeric(24, 4)
MAX_ABS = Decimal("1e20")  # 20 integer digits
_FLOAT_NOISE = Decimal("1e-7")

_BLANKS = {"", "-", "–", "—", "--", "nil"}
_CREDIT_SUFFIX = re.compile(r"(?:cr|credit|دائن)$")   # دائن
_DEBIT_SUFFIX = re.compile(r"(?:dr|debit|مدين)$")     # مدين
_CURRENCY = re.compile(r"^(?:[a-z]{3}|[$€£¥]|د\.[اأ]\.?)|(?:[a-z]{3}|[$€£¥]|د\.[اأ]\.?)$")
_NUMBER = re.compile(r"^\d+(?:[.,]\d+)*$|^\d*[.,]\d+$")


class AmountError(ValueError):
    pass


def from_number(value: int | float | Decimal) -> Decimal:
    """Numeric cell -> Decimal. Floats come from the file as the shortest
    round-trip repr, so repr() recovers what Excel stored (no binary noise)."""
    if isinstance(value, bool):
        raise AmountError("boolean is not an amount")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise AmountError("non-finite number")
        d = Decimal(repr(value))
    else:
        d = Decimal(value)
    return _finish(d, from_float=isinstance(value, float))


def from_text(raw: str, decimal_separator: str | None = None) -> Decimal | None:
    text, _ = clean_display(raw)
    s = ascii_digits(text).replace(" ", "").replace(" ", "").replace(" ", "").casefold()
    s = s.replace("٫", ".").replace("٬", ",").replace("،", ",")  # Arabic decimal / thousands / comma
    if s in _BLANKS:
        return None

    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative, s = True, s[1:-1]
    m = _CREDIT_SUFFIX.search(s)
    if m:
        negative, s = not negative, s[: m.start()]
    else:
        m = _DEBIT_SUFFIX.search(s)
        if m:
            s = s[: m.start()]
    s = _CURRENCY.sub("", s)
    if s.startswith("-"):
        negative, s = not negative, s[1:]
    elif s.endswith("-"):
        negative, s = not negative, s[:-1]
    elif s.startswith("+"):
        s = s[1:]
    s = _CURRENCY.sub("", s)

    if not _NUMBER.match(s):
        raise AmountError("not a number")
    s = _canonical(s, decimal_separator)
    try:
        d = Decimal(s)
    except InvalidOperation as exc:  # pragma: no cover - regex guarantees shape
        raise AmountError("not a number") from exc
    return _finish(-d if negative else d, from_float=False)


def _canonical(s: str, decimal_separator: str | None) -> str:
    if decimal_separator == ".":
        return s.replace(",", "")
    if decimal_separator == ",":
        return s.replace(".", "").replace(",", ".")
    has_dot, has_comma = "." in s, "," in s
    if has_dot and has_comma:
        dec, grp = (".", ",") if s.rfind(".") > s.rfind(",") else (",", ".")
        whole, _, frac = s.rpartition(dec)
        if dec in whole or any(len(g) != 3 for g in whole.split(grp)[1:]):
            raise AmountError("inconsistent digit grouping")
        return whole.replace(grp, "") + "." + frac
    sep = "." if has_dot else "," if has_comma else None
    if sep is None:
        return s
    parts = s.split(sep)
    if len(parts) > 2:  # 1.234.567 or 1,234,567
        if any(len(p) != 3 for p in parts[1:]):
            raise AmountError("inconsistent digit grouping")
        return "".join(parts)
    if sep == "," and len(parts[1]) == 3:
        return "".join(parts)  # 1,234 -> thousands
    return parts[0] + "." + parts[1]


def _finish(d: Decimal, from_float: bool) -> Decimal:
    if not d.is_finite():
        raise AmountError("non-finite number")
    q = d.quantize(SCALE, rounding=ROUND_HALF_EVEN)
    # More than 4 real decimals is a data problem; a float's binary noise
    # (100.00000000000001) is not.
    if q != d and (not from_float or abs(q - d) > _FLOAT_NOISE):
        raise AmountError("more than 4 decimal places")
    if abs(q) >= MAX_ABS:
        raise AmountError("amount out of range")
    return q + 0  # normalise -0 to 0


def parse_cell(value: object, row: int, column: str, decimal_separator: str | None) -> Decimal | None:
    """Parse one cell or raise a ParseError naming the row and column letter."""
    try:
        if value is None:
            return None
        if isinstance(value, (int, float, Decimal)):
            return from_number(value)
        if isinstance(value, str):
            return from_text(value, decimal_separator)
        raise AmountError(f"unsupported cell type {type(value).__name__}")
    except AmountError as exc:
        raise ParseError("bad_amount", f"Row {row}, column {column}: {exc}.", row) from exc


def fmt(d: Decimal | None) -> str | None:
    return None if d is None else format(d.quantize(SCALE), "f")
