/**
 * Amounts arrive from the API as exact decimal strings ("-1234.5000"). They
 * are formatted with string arithmetic only: a binary float never touches a
 * balance on its way to the screen.
 */
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

export interface FormattedAmount {
  text: string;        // grouped absolute value, 2-4 decimals
  negative: boolean;
  zero: boolean;
}

export function formatAmount(value: string, minDecimals = 2, maxDecimals = 4): FormattedAmount {
  const m = DECIMAL.exec(value.trim());
  if (!m) return { text: value, negative: false, zero: false };
  const [, sign, intPart = '0', fracRaw = ''] = m;
  let frac = fracRaw.slice(0, maxDecimals).replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  const int = intPart.replace(/^0+(?=\d)/, '');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const zero = /^0*$/.test(int) && /^0*$/.test(fracRaw);
  return { text: frac ? `${grouped}.${frac}` : grouped, negative: sign === '-' && !zero, zero };
}

/** Split a signed closing balance (debit +, credit -) into TB columns. */
export function debitCredit(closing: string): { debit: string | null; credit: string | null } {
  const f = formatAmount(closing);
  if (f.zero) return { debit: null, credit: null };
  return f.negative ? { debit: null, credit: f.text } : { debit: f.text, credit: null };
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Dates and times in the UI language (Latin digits, as used in Jordanian practice). */
export function formatDateTime(iso: string, locale: 'en' | 'ar'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
