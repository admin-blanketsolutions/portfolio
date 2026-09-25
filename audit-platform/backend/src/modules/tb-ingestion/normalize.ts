/**
 * TypeScript port of parser/tb_parser/normalize.py. The parser normalises TB
 * account names in the sandbox; the backend must produce the SAME matching
 * form for the other side of each comparison (chart-of-accounts names, firm
 * rules). Both implementations are tested against
 * parser/tests/golden/normalization.json.
 */

const INVISIBLE = new Set([
  0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068,
  0x2069, 0xfeff, 0x00ad,
]);
const ZW_JOINERS = new Set([0x200c, 0x200d]);

const ARABIC_FOLD: Record<string, string> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ٲ': 'ا', 'ٳ': 'ا',
  'ى': 'ي', 'ی': 'ي', 'ئ': 'ي',
  'ؤ': 'و',
  'ة': 'ه',
  'ک': 'ك',
};

const CONTROL = /\p{Cc}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const DECIMAL_DIGIT = /\p{Nd}/u;
const WS = /\s+/gu;

function isTashkeel(cp: number): boolean {
  return (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || (cp >= 0x06d6 && cp <= 0x06ed);
}

/** Remove characters that make text render differently from its bytes. */
export function cleanDisplay(text: string): { text: string; removed: boolean } {
  let out = '';
  let removed = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (INVISIBLE.has(cp)) { removed = true; continue; }
    if (CONTROL.test(ch)) {
      if ('\t\n\r\v\f'.includes(ch)) out += ' ';
      else removed = true;
      continue;
    }
    out += cp === 0x2028 || cp === 0x2029 ? ' ' : ch;
  }
  return { text: out.replace(WS, ' ').trim(), removed };
}

/**
 * Value of a Unicode decimal digit. Nd characters come in runs that start at a
 * zero and are whole multiples of ten long (e.g. the five consecutive sets of
 * mathematical digits), so the value is the offset from the run start mod 10.
 */
function digitValue(ch: string): string {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (cp - start < 100 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((cp - start) % 10);
}

export function asciiDigits(text: string): string {
  let out = '';
  for (const ch of text) out += DECIMAL_DIGIT.test(ch) ? digitValue(ch) : ch;
  return out;
}

/** Python str.casefold() for the scripts we handle: upper-then-lower expands ß -> ss, folds final sigma. */
function casefold(s: string): string {
  return s.toUpperCase().toLowerCase();
}

export function normalizeForMatching(text: string): string {
  const cleaned = cleanDisplay(text).text;
  const s = asciiDigits(casefold(cleaned.normalize('NFKC')));
  let out = '';
  for (let ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isTashkeel(cp) || cp === 0x0640 || ZW_JOINERS.has(cp)) continue;
    ch = ARABIC_FOLD[ch] ?? ch;
    out += LETTER_OR_NUMBER.test(ch) ? ch : ' ';
  }
  return out.replace(WS, ' ').trim();
}

/** Account codes: invisible characters out, ASCII digits, trimmed, upper-case. */
export function normalizeCode(code: string): string {
  return asciiDigits(cleanDisplay(code).text).toUpperCase();
}
