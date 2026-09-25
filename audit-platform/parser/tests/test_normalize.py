import json
import pathlib

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tb_parser.normalize import ascii_digits, clean_display, looks_like_formula, normalize_for_matching

GOLDEN = json.loads((pathlib.Path(__file__).parent / "golden" / "normalization.json").read_text("utf-8"))


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["input"][:24])
def test_golden_vectors(case):
    display, removed = clean_display(case["input"])
    assert display == case["display"]
    assert removed == case["display_removed"]
    assert normalize_for_matching(case["input"]) == case["match"]


def test_bidi_override_cannot_survive_display():
    # "cod.exe" rendered as "exe.doc" is the classic RLO trick.
    display, removed = clean_display("‮evil⁦name⁩")
    assert removed and display == "evilname"
    assert not any(0x202A <= ord(c) <= 0x202E or 0x2066 <= ord(c) <= 0x2069 for c in display)


def test_arabic_indic_and_persian_digits():
    assert ascii_digits("١٢٣ ۴۵") == "123 45"


@pytest.mark.parametrize("text,expected", [
    ("=HYPERLINK(\"http://x\")", True), ("+cmd", True), ("@SUM(A1)", True), ("-2+3+cmd|' /C calc'!A0", True),
    ("-1,234.50", False), ("Cash", False), ("١٢", False),
])
def test_formula_like(text, expected):
    assert looks_like_formula(text) is expected


@given(st.text(max_size=200))
def test_matching_form_is_idempotent_and_clean(text):
    once = normalize_for_matching(text)
    assert normalize_for_matching(once) == once
    assert once == once.strip()
    assert "  " not in once


@given(st.text(max_size=200))
def test_display_never_contains_invisible_controls(text):
    display, _ = clean_display(text)
    for ch in display:
        cp = ord(ch)
        assert not (0x202A <= cp <= 0x202E or 0x2066 <= cp <= 0x2069 or cp in (0x200B, 0x200E, 0x200F, 0xFEFF, 0x061C))
        assert cp >= 0x20 or ch == " "
