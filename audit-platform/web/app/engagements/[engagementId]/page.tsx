'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { ImportsPanel } from '@/components/ImportsPanel';
import { TrialBalanceReview } from '@/components/TrialBalanceReview';
import { useI18n } from '@/lib/i18n';
import type { TbImport } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default function EngagementTrialBalancePage() {
  const { engagementId } = useParams<{ engagementId: string }>();
  const { t } = useI18n();
  const [selected, setSelected] = useState<TbImport | null>(null);
  const onSelect = useCallback((imp: TbImport) => setSelected(imp), []);
  if (!UUID.test(engagementId)) return <p>{t('error.notFound')}</p>;

  return (
    <div className="workspace">
      <nav className="crumbs"><Link href="/">{t('engagement.back')}</Link></nav>
      <ImportsPanel engagementId={engagementId} selected={selected?.id ?? null} onSelect={onSelect} />
      {selected?.trialBalanceId && <TrialBalanceReview key={selected.trialBalanceId} trialBalanceId={selected.trialBalanceId} />}
    </div>
  );
}
