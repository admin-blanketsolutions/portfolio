import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asciiDigits, cleanDisplay, normalizeCode, normalizeForMatching } from '../../src/modules/tb-ingestion/normalize.js';

interface GoldenCase { input: string; display: string; display_removed: boolean; match: string }
const golden = JSON.parse(readFileSync(new URL('../../../parser/tests/golden/normalization.json', import.meta.url), 'utf8')) as { cases: GoldenCase[] };

describe('normalisation parity with the Python parser', () => {
  it.each(golden.cases.map((c) => [c.input.slice(0, 30), c] as const))('golden: %s', (_label, c) => {
    expect(cleanDisplay(c.input)).toEqual({ text: c.display, removed: c.display_removed });
    expect(normalizeForMatching(c.input)).toBe(c.match);
  });

  it('maps every script\'s decimal digits, including adjacent digit runs', () => {
    expect(asciiDigits('١٢٣ ۴۵ १')).toBe('123 45 1');
    // Mathematical digits: five consecutive runs of ten (bold, double-struck, ...).
    expect(asciiDigits(String.fromCodePoint(0x1d7ce, 0x1d7d9, 0x1d7e5, 0x1d7ff))).toBe('0139');
  });

  it('normalises account codes for comparison', () => {
    expect(normalizeCode(' ‏١٠١-a ')).toBe('101-A');
  });
});
