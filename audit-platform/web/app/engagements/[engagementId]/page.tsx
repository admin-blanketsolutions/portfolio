'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { FinancialStatements } from '@/components/FinancialStatements';
import { ImportsPanel } from '@/components/ImportsPanel';
import { TrialBalanceReview } from '@/components/TrialBalanceReview';
import { useI18n } from '@/lib/i18n';
import type { TbImport } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default function EngagementTrialBalancePage() {
  const { engagementId } = useParams<{ engagementId: string }>();
  const { t } = useI18n();
  const [selected, setSelected] = useState<TbImport | null>(null);
  const [view, setView] = useState<'tb' | 'fs'>('tb');
  const onSelect = useCallback((imp: TbImport) => setSelected(imp), []);
  if (!UUID.test(engagementId)) return <p>{t('error.notFound')}</p>;

  return (
    <div className="workspace">
      <nav className="crumbs"><Link href="/">{t('engagement.back')}</Link></nav>
      <div className="tabs page-tabs" role="tablist">
        {(['tb', 'fs'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={`tab${view === v ? ' active' : ''}`}
                  onClick={() => setView(v)}>{t(`engagement.tab.${v}`)}</button>
        ))}
      </div>
      {view === 'fs' ? <FinancialStatements engagementId={engagementId} /> : (
        <>
          <ImportsPanel engagementId={engagementId} selected={selected?.id ?? null} onSelect={onSelect} />
          {selected?.trialBalanceId && <TrialBalanceReview key={selected.trialBalanceId} trialBalanceId={selected.trialBalanceId} />}
        </>
      )}
    </div>
  );
}
