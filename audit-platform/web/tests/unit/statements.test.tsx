import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancialStatements } from '@/components/FinancialStatements';
import type { ApiClient } from '@/lib/api';
import { AuthContext, type Auth } from '@/lib/auth';
import { I18nProvider, type Locale } from '@/lib/i18n';
import type { Statements } from '@/lib/types';

afterEach(cleanup);

const node = (code: string, level: number, isPostable: boolean, amount: string, nameEn: string, nameAr: string, accountClass = 'asset') =>
  ({ code, path: `X.${code}`, nameEn, nameAr, level, isPostable, amount, accountClass });

const locked: Statements = {
  currency: 'JOD',
  trialBalance: { id: 'tb1', version: 2, asOfDate: '2025-12-31', lockedAt: '2026-01-15T10:00:00Z', sourceFilename: 'TB.xlsx' },
  balanceSheet: [
    node('BS.A', 1, false, '150000.0000', 'Assets', 'الموجودات'),
    node('1320', 2, true, '96000.0000', 'Machinery and equipment', 'آلات ومعدات'),
    node('1360', 2, true, '-71230.0000', 'Accumulated depreciation', 'مجمع الاستهلاك'),
    node('BS.L', 1, false, '30000.0000', 'Liabilities', 'المطلوبات', 'liability'),
    node('BS.E', 1, false, '70000.0000', 'Equity', 'حقوق الملكية', 'equity'),
  ],
  incomeStatement: [node('IS.REV', 1, false, '200000.0000', 'Revenue', 'الإيرادات')],
  totals: { assets: '150000.0000', liabilitiesAndEquity: '150000.0000', profit: '50000.0000', balanced: true },
  integrity: [{ check: 'unadjusted TB nets to zero', ok: true }],
};

function renderWith(data: Statements, locale: Locale = 'en') {
  const api = { statements: vi.fn(async () => data) };
  const auth = { status: 'signed-in', mode: 'dev-token', api: api as unknown as ApiClient, expired: false } as Auth;
  const wrap = ({ children }: { children: ReactNode }) => (
    <I18nProvider forced={locale}><AuthContext.Provider value={auth}>{children}</AuthContext.Provider></I18nProvider>
  );
  return { api, ...render(<FinancialStatements engagementId="e1" />, { wrapper: wrap }) };
}

describe('financial statements', () => {
  it('shows contra balances in brackets, the profit in equity and the balance check', async () => {
    const { api } = renderWith(locked);
    const bs = await screen.findByTestId('statement-bs');
    expect(api.statements).toHaveBeenCalledWith('e1');
    expect(within(bs).getByText('(71,230.00)')).toBeInTheDocument();
    expect(within(bs).getByText('Profit for the year (in equity)')).toBeInTheDocument();
    // Order: assets, their total, liabilities, equity, the year's profit, the grand total.
    const labels = within(bs).getAllByRole('row').slice(1).map((r) => (r as HTMLTableRowElement).cells[0]!.textContent);
    expect(labels).toEqual(['Assets', 'Machinery and equipment', 'Accumulated depreciation', 'Total assets', 'Liabilities', 'Equity',
      'Profit for the year (in equity)', 'Total liabilities and equity']);
    expect(within(bs).getAllByText('150,000.00').length).toBeGreaterThanOrEqual(2);   // assets = liabilities + equity
    expect(screen.getByText('Balances')).toBeInTheDocument();
    expect(screen.getByText(/All integrity checks passed/)).toBeInTheDocument();
    expect(within(screen.getByTestId('statement-is')).getByText('Profit for the year')).toBeInTheDocument();
  });

  it('warns loudly when the statements do not balance or a check fails', async () => {
    renderWith({ ...locked, totals: { ...locked.totals, balanced: false }, integrity: [{ check: 'adjusted TB nets to zero', ok: false }] });
    expect(await screen.findByText('Does not balance — review the mapping')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('adjusted TB nets to zero');
  });

  it('reports a loss as a loss', async () => {
    renderWith({ ...locked, totals: { ...locked.totals, profit: '-1250.5000' } });
    const is = await screen.findByTestId('statement-is');
    expect(within(is).getByText('Loss for the year')).toBeInTheDocument();
    expect(within(is).getByText('(1,250.50)')).toBeInTheDocument();
  });

  it('asks for a locked trial balance first', async () => {
    renderWith({ ...locked, trialBalance: null, balanceSheet: [], incomeStatement: [] });
    expect(await screen.findByText('Lock the trial balance to see the draft financial statements.')).toBeInTheDocument();
  });

  it('uses the Arabic account names in Arabic', async () => {
    renderWith(locked, 'ar');
    const bs = await screen.findByTestId('statement-bs');
    expect(within(bs).getByText('مجمع الاستهلاك')).toBeInTheDocument();
    expect(screen.getByText('قائمة الأرباح أو الخسائر')).toBeInTheDocument();
  });
});
