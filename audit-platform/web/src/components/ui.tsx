'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { debitCredit } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Flag, MappingSource } from '@/lib/types';

/** Client-supplied text: isolated from the surrounding direction, never interpreted as markup. */
export function ClientText({ children, className }: { children: string; className?: string }) {
  return <bdi dir="auto" className={className}>{children}</bdi>;
}

export function Amount({ value }: { value: string | null }) {
  if (value === null) return <span className="amount muted" aria-hidden="true">—</span>;
  return <bdi dir="ltr" className="amount">{value}</bdi>;
}

export function DebitCreditCells({ closing }: { closing: string }) {
  const { debit, credit } = debitCredit(closing);
  return (
    <>
      <td className="num"><Amount value={debit} /></td>
      <td className="num"><Amount value={credit} /></td>
    </>
  );
}

export function SourceBadge({ source }: { source: MappingSource }) {
  const { t } = useI18n();
  return <span className={`badge source source-${source}`}>{t(`source.${source}`)}</span>;
}

export function FlagBadges({ flags }: { flags: readonly Flag[] }) {
  const { t } = useI18n();
  if (flags.length === 0) return null;
  return (
    <ul className="flags" aria-label="flags">
      {flags.map((f) => (
        <li key={f} className={`badge flag flag-${f}`} title={t(`flag.${f}.help`)}>
          <span aria-hidden="true">⚑ </span>{t(`flag.${f}`)}
        </li>
      ))}
    </ul>
  );
}

export function StatusPill({ tone, children }: { tone: 'neutral' | 'progress' | 'ok' | 'bad'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Notice({ tone, children }: { tone: 'info' | 'error' | 'ok'; children: ReactNode }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`notice notice-${tone}`}>{children}</div>;
}

/** Accessible modal: labelled, focus moves in on open and back on close, Escape closes. */
export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previously?.focus(); };
  }, [onClose]);
  const { t } = useI18n();
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="modal">
        <header className="modal-header">
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-footer">{footer}</footer>
      </div>
    </div>
  );
}
