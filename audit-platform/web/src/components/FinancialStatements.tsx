'use client';

import { Fragment, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatAmount, formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { StatementNode, Statements } from '@/lib/types';
import { ClientText, Notice } from './ui';

/** Negative amounts in brackets, as on printed statements. */
function StatementAmount({ value }: { value: string }) {
  const f = formatAmount(value);
  return <bdi dir="ltr" className="amount">{f.negative ? `(${f.text})` : f.text}</bdi>;
}

/** Split a statement into its top-level sections (level 1) with their descendants. */
function sections(nodes: StatementNode[]): Array<{ head: StatementNode; nodes: StatementNode[] }> {
  const out: Array<{ head: StatementNode; nodes: StatementNode[] }> = [];
  for (const n of nodes) {
    if (n.level === 1 || out.length === 0) out.push({ head: n, nodes: [n] });
    else out[out.length - 1]!.nodes.push(n);
  }
  return out;
}

function Rows({ nodes }: { nodes: StatementNode[] }) {
  const { locale } = useI18n();
  return (
    <>
      {nodes.map((n) => (
        <tr key={n.path} className={n.isPostable ? 'fs-account' : `fs-group fs-level-${Math.min(n.level, 3)}`}>
          <td style={{ paddingInlineStart: `${0.6 + (n.level - 1) * 1.1}rem` }}>{locale === 'ar' ? n.nameAr : n.nameEn}</td>
          <td className="num"><StatementAmount value={n.amount} /></td>
        </tr>
      ))}
    </>
  );
}

export function FinancialStatements({ engagementId }: { engagementId: string }) {
  const { api } = useAuth();
  const { t, locale } = useI18n();
  const [data, setData] = useState<Statements | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.statements(engagementId).then(setData, (e: unknown) => setError(e instanceof ApiError ? e.message : t('error.generic')));
  }, [api, engagementId, t]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p>{t('common.loading')}</p>;
  if (!data.trialBalance) return <section className="panel"><Notice tone="info">{t('fs.notLocked')}</Notice></section>;

  const tb = data.trialBalance;
  const currency = data.currency ?? '';
  const profitNegative = formatAmount(data.totals.profit).negative;
  const failed = data.integrity.filter((c) => !c.ok);
  const head = (
    <thead><tr><th>{t('fs.lineItem')}</th><th className="num">{t('fs.amount', { currency })}</th></tr></thead>
  );

  return (
    <section className="panel statements">
      <div className="panel-head">
        <div>
          <h2>{t('engagement.tab.fs')}</h2>
          <p className="muted small">{t('fs.draft')}</p>
          <p className="muted small">
            {/* Each part is direction-isolated: file names and dates must not reorder in Arabic. */}
            <bdi>{t('fs.source', { version: String(tb.version), date: tb.asOfDate })}</bdi>
            {' · '}<ClientText>{tb.sourceFilename}</ClientText>{' · '}<bdi>{formatDateTime(tb.lockedAt, locale)}</bdi>
          </p>
        </div>
        <div className="head-actions">
          <span className={`pill ${data.totals.balanced ? 'pill-ok' : 'pill-bad'}`}>
            {data.totals.balanced ? t('fs.balanced') : t('fs.unbalanced')}
          </span>
        </div>
      </div>
      {failed.length === 0
        ? <p className="small muted">✓ {t('fs.checksOk')}</p>
        : failed.map((c) => <Notice key={c.check} tone="error">{t('fs.checkFailed', { check: c.check })}</Notice>)}

      <h3>{t('fs.bs')}</h3>
      <div className="table-wrap">
        <table className="lines fs-table" data-testid="statement-bs">
          {head}
          <tbody>
            {sections(data.balanceSheet).map((sec, i, all) => {
              const lastAsset = sec.head.accountClass === 'asset' && all[i + 1]?.head.accountClass !== 'asset';
              return (
                <Fragment key={sec.head.path}>
                  <Rows nodes={sec.nodes} />
                  {lastAsset && <tr className="fs-total"><td>{t('fs.totalAssets')}</td><td className="num"><StatementAmount value={data.totals.assets} /></td></tr>}
                  {sec.head.accountClass === 'equity' && (
                    <tr className="fs-note"><td style={{ paddingInlineStart: '1.7rem' }}>{profitNegative ? t('fs.lossInEquity') : t('fs.profitInEquity')}</td>
                      <td className="num"><StatementAmount value={data.totals.profit} /></td></tr>
                  )}
                </Fragment>
              );
            })}
            <tr className="fs-total"><td>{t('fs.totalLE')}</td><td className="num"><StatementAmount value={data.totals.liabilitiesAndEquity} /></td></tr>
          </tbody>
        </table>
      </div>

      <h3>{t('fs.is')}</h3>
      <div className="table-wrap">
        <table className="lines fs-table" data-testid="statement-is">
          {head}
          <tbody>
            <Rows nodes={data.incomeStatement} />
            <tr className="fs-total"><td>{profitNegative ? t('fs.loss') : t('fs.profit')}</td><td className="num"><StatementAmount value={data.totals.profit} /></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
