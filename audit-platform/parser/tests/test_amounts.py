from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tb_parser.amounts import AmountError, fmt, from_number, from_text, parse_cell
from tb_parser.errors import ParseError


@pytest.mark.parametrize("text,expected", [
    ("1234.5", "1234.5000"),
    ("1,234.50", "1234.5000"),
    ("1.234,50", "1234.5000"),
    ("1,234", "1234.0000"),
    ("1234,5", "1234.5000"),
    ("1,234,567.891", "1234567.8910"),
    ("1.234.567", "1234567.0000"),
    ("(1,234.50)", "-1234.5000"),
    ("-1,234.50", "-1234.5000"),
    ("1,234.50-", "-1234.5000"),
    ("1,234.50 CR", "-1234.5000"),
    ("1,234.50 Dr", "1234.5000"),
    ("1234.50 دائن", "-1234.5000"),
    ("1234.50 مدين", "1234.5000"),
    ("١٬٢٣٤٫٥٠", "1234.5000"),   # ١٬٢٣٤٫٥٠
    ("JOD 1,234.500", "1234.5000"),
    ("$1,234", "1234.0000"),
    (" 1 234.5 ", "1234.5000"),
    ("‏-500", "-500.0000"),
    ("0.0001", "0.0001"),
    ("-0", "0.0000"),
])
def test_text_forms(text, expected):
    assert fmt(from_text(text)) == expected


@pytest.mark.parametrize("text", ["", "-", "—", "  ", "nil"])
def test_blank_forms(text):
    assert from_text(text) is None


@pytest.mark.parametrize("text", ["abc", "1.2.3,4", "12..5", "1,23,4", "1e5", "0x10", "=1+1", "1.23456", "∞"])
def test_rejected_forms(text):
    with pytest.raises(AmountError):
        from_text(text)


def test_declared_separator_wins():
    assert fmt(from_text("1.234", decimal_separator=",")) == "1234.0000"
    assert fmt(from_text("1,5", decimal_separator=".")) == "15.0000"


def test_float_noise_is_absorbed_but_real_precision_is_not():
    assert fmt(from_number(0.1 + 0.2)) == "0.3000"
    assert fmt(from_number(100.00000000000001)) == "100.0000"
    with pytest.raises(AmountError):
        from_number(1234.56789)
    with pytest.raises(AmountError):
        from_number(float("nan"))
    with pytest.raises(AmountError):
        from_number(True)


def test_out_of_range():
    with pytest.raises(AmountError):
        from_text("100000000000000000000")


def test_parse_cell_reports_row_and_column():
    with pytest.raises(ParseError) as exc:
        parse_cell("twelve", 17, "D", None)
    assert exc.value.code == "bad_amount" and exc.value.row == 17 and "column D" in exc.value.message


money = st.decimals(min_value=Decimal("-1e15"), max_value=Decimal("1e15"), places=4, allow_nan=False, allow_infinity=False)


@given(money)
def test_round_trip_plain(d):
    assert from_text(format(d, "f")) == d


@given(money)
def test_round_trip_grouped_parenthesised(d):
    grouped = f"{abs(d):,.4f}"
    text = f"({grouped})" if d < 0 else grouped
    assert from_text(text) == d


@given(money)
def test_round_trip_arabic(d):
    arabic = f"{abs(d):,.4f}".translate(str.maketrans("0123456789,.", "٠١٢٣٤٥٦٧٨٩٬٫"))
    assert from_text(arabic + (" دائن" if d < 0 else "")) == d
