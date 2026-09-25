'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { TbImport } from '@/lib/types';
import { ClientText, Notice, StatusPill } from './ui';

const POLL_MS = 1500;
const TONE = { received: 'neutral', processing: 'progress', imported: 'ok', failed: 'bad' } as const;

export function ImportsPanel({ engagementId, selected, onSelect }: {
  engagementId: string;
  selected: string | null;
  onSelect: (imp: TbImport) => void;
}) {
  const { api } = useAuth();
  const { t, locale } = useI18n();
  const [imports, setImports] = useState<TbImport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.imports(engagementId);
      setImports(r.imports);
      setError(null);
      return r.imports;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('error.generic'));
      return null;
    }
  }, [api, engagementId, t]);

  useEffect(() => { void load(); }, [load]);

  // Poll while anything is queued or processing.
  const busy = imports?.some((i) => i.status === 'received' || i.status === 'processing') ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  // Open the newest successful import on arrival, and a fresh upload as soon as it is imported.
  const autoOpened = useRef(false);
  const justUploaded = useRef<string | null>(null);
  useEffect(() => {
    if (!imports) return;
    const uploaded = justUploaded.current ? imports.find((i) => i.id === justUploaded.current) : undefined;
    if (uploaded && (uploaded.status === 'imported' || uploaded.status === 'failed')) {
      justUploaded.current = null;
      if (uploaded.status === 'imported') { autoOpened.current = true; onSelect(uploaded); }
      return;
    }
    if (autoOpened.current || selected) return;
    const latest = imports.find((i) => i.status === 'imported');
    if (latest) { autoOpened.current = true; onSelect(latest); }
  }, [imports, selected, onSelect]);

  const onUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const created = await api.upload(engagementId, file);
      justUploaded.current = created.id;
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('error.generic'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="panel" aria-labelledby="imports-title">
      <div className="panel-head">
        <h2 id="imports-title">{t('imports.title')}</h2>
        <label className={`button primary${uploading ? ' disabled' : ''}`}>
          {uploading ? t('imports.uploading') : t('imports.upload')}
          <input ref={fileRef} type="file" accept=".xlsx,.csv" className="visually-hidden" disabled={uploading}
                 data-testid="tb-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }} />
        </label>
      </div>
      <p className="hint">{t('imports.uploadHint')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {imports === null ? <p>{t('common.loading')}</p> : imports.length === 0 ? <p className="muted">{t('imports.empty')}</p> : (
        <ul className="imports">
          {imports.map((imp) => (
            <li key={imp.id} className={imp.id === selected ? 'selected' : undefined} data-testid="import-row">
              <div className="import-main">
                <ClientText className="filename">{imp.filename}</ClientText>
                <StatusPill tone={TONE[imp.status]}>{t(`imports.status.${imp.status}`)}</StatusPill>
              </div>
              <div className="import-meta muted">
                <time dateTime={imp.createdAt}>{formatDateTime(imp.createdAt, locale)}</time>
                {imp.report?.control && <span>{t('imports.lines', { count: imp.report.control.line_count })}</span>}
                {imp.report?.warnings && imp.report.warnings.length > 0 && (
                  <span title={imp.report.warnings.map((w) => w.message).join('\n')}>
                    {t('imports.warnings', { count: imp.report.warnings.length })}
                  </span>
                )}
                {imp.mappingSummary && (
                  <span>{t('imports.mapping', {
                    suggested: Object.values(imp.mappingSummary.suggested).reduce((a, b) => a + b, 0),
                    unmatched: imp.mappingSummary.unmatched,
                  })}</span>
                )}
              </div>
              {imp.failure && <Notice tone="error">{imp.failure.message}</Notice>}
              {imp.status === 'imported' && imp.id !== selected && (
                <button type="button" className="link" onClick={() => onSelect(imp)}>{t('imports.review')}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
