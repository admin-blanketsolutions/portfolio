'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatAmount, formatDateTime, formatPercent } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { CoaAccount, LineFilter, ReviewLine, TrialBalance } from '@/lib/types';
import { ClientText, DebitCreditCells, FlagBadges, Modal, Notice, SourceBadge, StatusPill } from './ui';

const PAGE = 200;
const FILTERS: LineFilter[] = ['open', 'pending', 'unmapped', 'accepted', 'all'];

/** A line can be bulk-accepted only if it has a pending, unflagged suggestion. */
export function bulkEligible(line: ReviewLine): boolean {
  return line.accepted === null && line.suggestion !== null && line.suggestion.flags.length === 0;
}

export function TrialBalanceReview({ trialBalanceId }: { trialBalanceId: string }) {
  const { api } = useAuth();
  const { t, locale } = useI18n();
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [filter, setFilter] = useState<LineFilter>('open');
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [acceptFor, setAcceptFor] = useState<ReviewLine | null>(null);
  const [mapFor, setMapFor] = useState<ReviewLine | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const [working, setWorking] = useState(false);

  const fail = useCallback((e: unknown) => {
    setNotice({ tone: 'error', text: e instanceof ApiError ? e.message : t('error.generic') });
  }, [t]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, page] = await Promise.all([api.trialBalance(trialBalanceId), api.lines(trialBalanceId, { status: filter, limit: PAGE })]);
      setTb(summary);
      setLines(page.lines);
      setNext(page.nextAfterLine);
      setSelected(new Set());
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [api, trialBalanceId, filter, fail]);

  useEffect(() => { void reload(); }, [reload]);

  const loadMore = async () => {
    if (next === null) return;
    try {
      const page = await api.lines(trialBalanceId, { status: filter, afterLine: next, limit: PAGE });
      setLines((prev) => [...prev, ...page.lines]);
      setNext(page.nextAfterLine);
    } catch (e) { fail(e); }
  };

  const run = async (fn: () => Promise<string | null>) => {
    setWorking(true);
    try {
      const message = await fn();
      if (message) setNotice({ tone: 'ok', text: message });
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setWorking(false);
    }
  };

  const editable = tb?.status === 'imported';
  const eligible = useMemo(() => lines.filter(bulkEligible), [lines]);
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const bulkAccept = () => run(async () => {
    const ids = lines.filter((l) => selected.has(l.id) && bulkEligible(l)).map((l) => l.suggestion!.mappingId);
    const r = await api.bulkAccept(trialBalanceId, ids);
    return t('bulk.result', { accepted: r.accepted.length, skipped: r.skipped.length });
  });

  const accept = (line: ReviewLine) => {
    if (!line.suggestion) return;
    if (line.suggestion.flags.length > 0) { setAcceptFor(line); return; }
    void run(async () => { await api.accept(line.suggestion!.mappingId); return null; });
  };

  if (!tb) {
    return <section className="panel">{notice ? <Notice tone="error">{notice.text}</Notice> : <p>{t('common.loading')}</p>}</section>;
  }

  const total = tb.control.lineCount;
  return (
    <section className="panel review" aria-labelledby="tb-title">
      <div className="panel-head">
        <div>
          <h2 id="tb-title">{t('tb.title', { version: tb.version, date: tb.asOfDate })}</h2>
          <p className="muted">
            <ClientText>{tb.sourceFilename}</ClientText> · {tb.currency} ·{' '}
            {t('tb.totals', { debit: formatAmount(tb.control.sumDebit).text, credit: formatAmount(tb.control.sumCredit).text })}
          </p>
        </div>
        <div className="head-actions">
          <StatusPill tone={tb.status === 'locked' ? 'ok' : tb.status === 'imported' ? 'progress' : 'neutral'}>
            {t(tb.status === 'locked' ? 'tb.status.locked' : tb.status === 'superseded' ? 'tb.status.superseded' : 'tb.status.imported')}
          </StatusPill>
          {editable && (
            <button type="button" className="button" disabled={working} onClick={() => setConfirmLock(true)}>{t('tb.lock')}</button>
          )}
        </div>
      </div>

      <progress className="progress" value={tb.mapping.accepted} max={Math.max(total, 1)}
                aria-label={t('tb.progress', { accepted: tb.mapping.accepted, total })} />
      <p className="muted small">{t('tb.progress', { accepted: tb.mapping.accepted, total })}</p>
      {tb.status === 'locked' && tb.lockedAt && <Notice tone="ok">{t('tb.locked', { at: formatDateTime(tb.lockedAt, locale) })}</Notice>}
      {!editable && tb.status !== 'locked' && <Notice tone="info">{t('tb.readOnly')}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <div className="toolbar">
        <div role="tablist" aria-label={t('col.mapping')} className="tabs">
          {FILTERS.map((f) => (
            <button key={f} role="tab" type="button" aria-selected={filter === f} className={filter === f ? 'tab active' : 'tab'}
                    onClick={() => setFilter(f)}>{t(`filter.${f}`)}</button>
          ))}
        </div>
        {editable && (
          <div className="bulk" aria-live="polite">
            <label className="check">
              <input type="checkbox" checked={eligible.length > 0 && eligible.every((l) => selected.has(l.id))}
                     disabled={eligible.length === 0}
                     onChange={(e) => setSelected(e.target.checked ? new Set(eligible.map((l) => l.id)) : new Set())} />
              {t('bulk.selectAll')}
            </label>
            <span className="muted">{t('bulk.selected', { count: selected.size })}</span>
            <button type="button" className="button primary" disabled={selected.size === 0 || working} onClick={() => void bulkAccept()}>
              {t('bulk.accept')}
            </button>
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table className="lines" aria-busy={loading}>
          <thead>
            <tr>
              {editable && <th scope="col" className="sel"><span className="visually-hidden">{t('bulk.selected', { count: '' })}</span></th>}
              <th scope="col">{t('col.code')}</th>
              <th scope="col">{t('col.name')}</th>
              <th scope="col" className="num">{t('col.debit')}</th>
              <th scope="col" className="num">{t('col.credit')}</th>
              <th scope="col">{t('col.mapping')}</th>
              {editable && <th scope="col">{t('col.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && !loading && (
              <tr><td colSpan={7} className="muted empty">{t('lines.empty')}</td></tr>
            )}
            {lines.map((line) => (
              <tr key={line.id} data-testid={`line-${line.code}`} className={line.suggestion?.flags.length ? 'flagged' : undefined}>
                {editable && (
                  <td className="sel">
                    {line.accepted === null && line.suggestion && (
                      <input type="checkbox" aria-label={`${line.code}`} checked={selected.has(line.id)}
                             disabled={!bulkEligible(line)} title={bulkEligible(line) ? undefined : t('bulk.flaggedHint')}
                             onChange={() => toggle(line.id)} />
                    )}
                  </td>
                )}
                <td className="code"><ClientText>{line.code}</ClientText></td>
                <td className="name">
                  <ClientText>{line.name}</ClientText>
                  <FlagBadges flags={line.flags} />
                </td>
                <DebitCreditCells closing={line.closing} />
                <td className="mapping">
                  {line.accepted ? (
                    <div className="decision">
                      <StatusPill tone="ok">{t('mapping.accepted')}</StatusPill>{' '}
                      <strong>{line.accepted.coaCode}</strong> {locale === 'ar' ? line.accepted.coaNameAr : line.accepted.coaNameEn}{' '}
                      <SourceBadge source={line.accepted.source} />
                    </div>
                  ) : line.suggestion ? (
                    <div className="suggestion">
                      <span className="muted">{t('mapping.suggested')}:</span>{' '}
                      <strong>{line.suggestion.coaCode}</strong>{' '}
                      {locale === 'ar' ? line.suggestion.coaNameAr : line.suggestion.coaNameEn}{' '}
                      <SourceBadge source={line.suggestion.source} />
                      {line.suggestion.confidence !== null && (
                        <span className="muted small"> · {t('mapping.confidence', { value: formatPercent(line.suggestion.confidence) })}</span>
                      )}
                      {line.suggestion.rationale && (
                        <p className="rationale small" title={line.suggestion.modelRef ? t('mapping.model', { ref: line.suggestion.modelRef }) : undefined}>
                          <ClientText>{line.suggestion.rationale}</ClientText>
                        </p>
                      )}
                      <FlagBadges flags={line.suggestion.flags.filter((f) => !line.flags.includes(f))} />
                    </div>
                  ) : <span className="muted">{t('mapping.none')}</span>}
                </td>
                {editable && (
                  <td>
                    <div className="actions">
                      {line.accepted === null && line.suggestion && (
                        <>
                          <button type="button" className="button small primary" disabled={working} onClick={() => accept(line)}>{t('action.accept')}</button>
                          <button type="button" className="button small" disabled={working}
                                  onClick={() => void run(async () => { await api.reject(line.suggestion!.mappingId); return null; })}>{t('action.reject')}</button>
                        </>
                      )}
                      <button type="button" className="button small ghost" disabled={working} onClick={() => setMapFor(line)}>
                        {line.accepted ? t('action.remap') : t('action.map')}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next !== null && <button type="button" className="button" onClick={() => void loadMore()}>{t('common.loadMore')}</button>}

      {acceptFor?.suggestion && (
        <AcceptFlaggedDialog line={acceptFor} onClose={() => setAcceptFor(null)} onConfirm={async () => {
          const id = acceptFor.suggestion!.mappingId;
          setAcceptFor(null);
          await run(async () => { await api.accept(id, true); return null; });
        }} />
      )}
      {mapFor && (
        <ManualMapDialog line={mapFor} onClose={() => setMapFor(null)} onSave={async (coaCode, rationale) => {
          const line = mapFor;
          setMapFor(null);
          await run(async () => { await api.manualMapping(trialBalanceId, line.id, coaCode, rationale); return null; });
        }} />
      )}
      {confirmLock && (
        <Modal title={t('tb.lock')} onClose={() => setConfirmLock(false)} footer={
          <>
            <button type="button" className="button" onClick={() => setConfirmLock(false)}>{t('common.cancel')}</button>
            <button type="button" className="button primary" onClick={() => {
              setConfirmLock(false);
              // No separate success message: the refreshed status shows the lock.
              void run(async () => { await api.lock(trialBalanceId); setNotice(null); return null; });
            }}>{t('tb.lock')}</button>
          </>
        }>
          <p>{t('tb.lockConfirm')}</p>
        </Modal>
      )}
    </section>
  );
}

function AcceptFlaggedDialog({ line, onClose, onConfirm }: { line: ReviewLine; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useI18n();
  const [ack, setAck] = useState(false);
  const s = line.suggestion!;
  return (
    <Modal title={t('accept.title')} onClose={onClose} footer={
      <>
        <button type="button" className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="button primary" disabled={!ack} onClick={() => void onConfirm()}>{t('accept.confirm')}</button>
      </>
    }>
      <p><strong><ClientText>{line.code}</ClientText></strong> · <ClientText>{line.name}</ClientText></p>
      <p>→ <strong>{s.coaCode}</strong> {s.coaNameEn} <SourceBadge source={s.source} /></p>
      <p>{t('accept.body')}</p>
      <ul className="flag-help">
        {s.flags.map((f) => <li key={f}><strong>{t(`flag.${f}`)}</strong>: {t(`flag.${f}.help`)}</li>)}
      </ul>
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        {t('accept.ack')}
      </label>
    </Modal>
  );
}

function ManualMapDialog({ line, onClose, onSave }: { line: ReviewLine; onClose: () => void; onSave: (coaCode: string, rationale: string) => Promise<void> }) {
  const { api } = useAuth();
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<CoaAccount[] | null>(null);
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.coa().then((r) => setAccounts(r.accounts), (e: unknown) => setError(e instanceof ApiError ? e.message : t('error.generic')));
  }, [api, t]);

  const q = query.trim().toLowerCase();
  const matches = (accounts ?? []).filter((a) => !q || a.code.toLowerCase().includes(q)
    || a.nameEn.toLowerCase().includes(q) || a.nameAr.includes(query.trim())).slice(0, 50);

  return (
    <Modal title={t('map.title')} onClose={onClose} footer={
      <>
        <button type="button" className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="button primary" disabled={!choice || rationale.trim().length < 3}
                onClick={() => void onSave(choice!, rationale.trim())}>{t('map.confirm')}</button>
      </>
    }>
      <p><strong><ClientText>{line.code}</ClientText></strong> · <ClientText>{line.name}</ClientText></p>
      {error && <Notice tone="error">{error}</Notice>}
      <label className="field">
        <span>{t('map.search')}</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      </label>
      {accounts === null ? <p>{t('common.loading')}</p> : (
        <fieldset className="coa-list">
          <legend className="visually-hidden">{t('map.search')}</legend>
          {matches.length === 0 && <p className="muted">{t('map.noResults')}</p>}
          {matches.map((a) => (
            <label key={a.id} className="coa-option">
              <input type="radio" name="coa" value={a.code} checked={choice === a.code} onChange={() => setChoice(a.code)} />
              <strong>{a.code}</strong> {locale === 'ar' ? a.nameAr : a.nameEn} <span className="muted small">{a.path}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="field">
        <span>{t('map.rationale')}</span>
        <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} maxLength={1000} />
      </label>
    </Modal>
  );
}
