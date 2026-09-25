import { describe, expect, it } from 'vitest';
import { debitCredit, formatAmount, formatDateTime } from '@/lib/format';
import { translate } from '@/lib/i18n';
import { ar } from '@/messages/ar';
import { en } from '@/messages/en';

describe('amount formatting (string arithmetic only)', () => {
  it.each([
    ['1234.5000', '1,234.50', false],
    ['-99500.0000', '99,500.00', true],
    ['0.0000', '0.00', false],
    ['-0.0000', '0.00', false],
    ['1234567890123456.1234', '1,234,567,890,123,456.1234', false],   // beyond float precision, still exact
    ['12.3450', '12.345', false],
    ['7', '7.00', false],
  ])('%s -> %s', (input, text, negative) => {
    expect(formatAmount(input)).toMatchObject({ text, negative });
  });

  it('splits signed balances into debit and credit columns', () => {
    expect(debitCredit('100.0000')).toEqual({ debit: '100.00', credit: null });
    expect(debitCredit('-30000.0000')).toEqual({ debit: null, credit: '30,000.00' });
    expect(debitCredit('0.0000')).toEqual({ debit: null, credit: null });
  });

  it('formats timestamps in the UI language with Latin digits', () => {
    const iso = '2026-01-15T09:30:00Z';
    expect(formatDateTime(iso, 'en')).toMatch(/2026/);
    expect(formatDateTime(iso, 'ar')).toMatch(/2026/);
    expect(formatDateTime(iso, 'ar')).not.toMatch(/[\u0660-\u0669]/);
    expect(formatDateTime('not a date', 'en')).toBe('not a date');
  });

  it('leaves anything that is not a decimal untouched', () => {
    expect(formatAmount('abc').text).toBe('abc');
  });
});

describe('message catalogs', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('Arabic covers every English key with the same placeholders', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(ar[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('interpolates variables and keeps unknown ones visible', () => {
    expect(translate('en', 'tb.progress', { accepted: 3, total: 8 })).toBe('3 of 8 lines accepted');
    expect(translate('ar', 'tb.progress', { accepted: 3, total: 8 })).toBe('تم قبول 3 من 8 سطر');
    expect(translate('en', 'tb.progress', { accepted: 3 })).toBe('3 of {total} lines accepted');
  });
});
