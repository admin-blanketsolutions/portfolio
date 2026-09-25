"""Header detection for English and Arabic trial balances.

Supported layouts (all resolve to a signed closing balance, debit +, credit -):

  closing_signed          Code | Name | [Dr | Cr movements] | Balance (signed)
  closing_dr_cr           Code | Name | [movements] | Closing Dr | Closing Cr
  dr_cr_as_closing        Code | Name | Debit | Credit          (the classic 2-column TB)
  opening_plus_movements  Code | Name | Opening | Debit | Credit (closing = opening + Dr - Cr)

Two-row headers ("Closing balance" merged over "Debit | Credit") are resolved
by forward-filling the row above and treating it as a group label.
Header text is compared after normalize_for_matching, so "رصيد أول المدة",
"رصيد اول المده" and "BALANCE (JOD)" all match their canonical forms.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from openpyxl.utils import get_column_letter

from .errors import ParseError
from .normalize import normalize_for_matching

_PARENS = re.compile(r"[(\[{].*?[)\]}]")


def _norm_set(*phrases: str) -> frozenset[str]:
    return frozenset(normalize_for_matching(p) for p in phrases)


CODE = _norm_set("code", "account code", "acct code", "account no", "account no.", "account number", "acc no",
                 "a/c no", "ac no", "gl code", "gl account", "gl no", "no", "no.",
                 "رقم الحساب", "رمز الحساب", "كود الحساب", "الرقم", "رقم", "الكود", "الرمز", "رقم الحساب العام")
NAME = _norm_set("name", "account name", "account", "description", "account description", "account title",
                 "details", "particulars", "اسم الحساب", "الحساب", "البيان", "الوصف", "اسم", "التفاصيل", "البند")
OPENING = _norm_set("opening balance", "opening", "beginning balance", "balance b/f", "balance brought forward",
                    "b/f", "رصيد افتتاحي", "الرصيد الافتتاحي", "رصيد أول المدة", "رصيد بداية المدة", "رصيد سابق")
DEBIT = _norm_set("debit", "dr", "debits", "مدين", "المدين")
CREDIT = _norm_set("credit", "cr", "credits", "دائن", "الدائن")
PERIOD_DEBIT = _norm_set("period debit", "movement debit", "debit movement", "debit movements", "debit turnover",
                         "حركة مدينة", "الحركة المدينة", "حركات مدينة", "مدين الفترة")
PERIOD_CREDIT = _norm_set("period credit", "movement credit", "credit movement", "credit movements",
                          "credit turnover", "حركة دائنة", "الحركة الدائنة", "حركات دائنة", "دائن الفترة")
CLOSING = _norm_set("closing balance", "balance", "closing", "ending balance", "net balance", "end balance",
                    "balance c/f", "الرصيد", "رصيد ختامي", "الرصيد الختامي", "رصيد آخر المدة",
                    "رصيد نهاية المدة", "الرصيد النهائي", "صافي الرصيد")
CLOSING_DEBIT = _norm_set("closing debit", "debit balance", "balance debit", "رصيد مدين", "الرصيد المدين")
CLOSING_CREDIT = _norm_set("closing credit", "credit balance", "balance credit", "رصيد دائن", "الرصيد الدائن")
OPENING_DEBIT = _norm_set("opening debit")
OPENING_CREDIT = _norm_set("opening credit")
GROUP_PERIOD = _norm_set("movement", "movements", "period", "period movement", "transactions", "activity",
                         "turnover", "الحركة", "الحركات", "حركة الفترة", "الحركة خلال الفترة")
GROUP_CLOSING = CLOSING | _norm_set("closing balances", "balances", "الأرصدة", "الأرصدة الختامية")
GROUP_OPENING = OPENING | _norm_set("opening balances", "الأرصدة الافتتاحية")
TOTAL_ROW = _norm_set("total", "totals", "grand total", "total balance", "المجموع", "الإجمالي", "اجمالي",
                      "المجموع الكلي", "الإجمالي العام", "المجاميع")

_DIRECT: tuple[tuple[str, frozenset[str]], ...] = (
    ("code", CODE), ("name", NAME), ("opening", OPENING), ("period_debit", PERIOD_DEBIT),
    ("period_credit", PERIOD_CREDIT), ("closing", CLOSING), ("closing_debit", CLOSING_DEBIT),
    ("closing_credit", CLOSING_CREDIT), ("opening_debit", OPENING_DEBIT), ("opening_credit", OPENING_CREDIT),
    ("debit", DEBIT), ("credit", CREDIT),
)


def header_text(value: object) -> str:
    if value is None:
        return ""
    return normalize_for_matching(_PARENS.sub(" ", str(value)))


def _classify(here: str, group: str) -> str | None:
    if not here:
        return None
    if group:
        side = "debit" if here in DEBIT else "credit" if here in CREDIT else None
        if side and group in GROUP_CLOSING:
            return f"closing_{side}"
        if side and group in GROUP_PERIOD:
            return f"period_{side}"
        if side and group in GROUP_OPENING:
            return f"opening_{side}"
    for role, names in _DIRECT:
        if here in names:
            return role
    return None


@dataclass
class Layout:
    header_row: int                      # 1-based sheet row of the (lower) header line
    kind: str
    columns: dict[str, int] = field(default_factory=dict)  # role -> 0-based column index

    def letters(self) -> dict[str, str]:
        return {role: get_column_letter(idx + 1) for role, idx in sorted(self.columns.items())}


def _resolve(found: dict[str, int], row_no: int) -> Layout | None:
    if "code" not in found or "name" not in found:
        return None
    cols = {"code": found["code"], "name": found["name"]}

    def period(from_generic: bool) -> None:
        if "period_debit" in found and "period_credit" in found:
            cols["period_debit"], cols["period_credit"] = found["period_debit"], found["period_credit"]
        elif from_generic and "debit" in found and "credit" in found:
            cols["period_debit"], cols["period_credit"] = found["debit"], found["credit"]

    def opening() -> None:
        if "opening" in found:
            cols["opening"] = found["opening"]
        elif "opening_debit" in found and "opening_credit" in found:
            cols["opening_debit"], cols["opening_credit"] = found["opening_debit"], found["opening_credit"]

    if "closing" in found:
        cols["closing"] = found["closing"]
        period(True)
        opening()
        return Layout(row_no, "closing_signed", cols)
    if "closing_debit" in found and "closing_credit" in found:
        cols["closing_debit"], cols["closing_credit"] = found["closing_debit"], found["closing_credit"]
        period(True)
        opening()
        return Layout(row_no, "closing_dr_cr", cols)
    has_opening = "opening" in found or ("opening_debit" in found and "opening_credit" in found)
    if has_opening:
        period(True)
        if "period_debit" not in cols:
            return None
        opening()
        return Layout(row_no, "opening_plus_movements", cols)
    if "debit" in found and "credit" in found and "period_debit" not in found:
        cols["closing_debit"], cols["closing_credit"] = found["debit"], found["credit"]
        return Layout(row_no, "dr_cr_as_closing", cols)
    return None


def detect(rows: list[tuple[object, ...]], first_row_no: int = 1) -> Layout:
    """Find the header among the first rows. `rows` are raw cell values."""
    above: list[str] = []
    ambiguous: list[str] = []
    for offset, row in enumerate(rows):
        row_no = first_row_no + offset
        here = [header_text(v) for v in row]
        found: dict[str, int] = {}
        dup: set[str] = set()
        for j, text in enumerate(here):
            group = above[j] if j < len(above) else ""
            role = _classify(text, group)
            if role is None:
                continue
            if role in found:
                dup.add(role)
            else:
                found[role] = j
        layout = _resolve(found, row_no)
        if layout is not None:
            clash = dup & set(layout.columns)
            if clash:
                ambiguous.append(f"row {row_no}: " + ", ".join(sorted(clash)))
            else:
                return layout
        # Forward-fill this row as the group labels for the next one (merged headers).
        filled: list[str] = []
        last = ""
        for text in here:
            last = text or last
            filled.append(last)
        above = filled
    if ambiguous:
        raise ParseError("ambiguous_header",
                         "More than one column matches the same heading (" + "; ".join(ambiguous[:3]) +
                         "). Rename or remove the duplicate column and upload again.")
    raise ParseError("header_not_found",
                     "Could not find a header row with an account code, an account name and balance columns "
                     "(for example: Code | Name | Debit | Credit, or رقم الحساب | اسم الحساب | الرصيد) "
                     f"in the first {len(rows)} rows.")
