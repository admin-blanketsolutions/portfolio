'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import type { Engagement } from '@/lib/types';

export default function EngagementsPage() {
  const { api } = useAuth();
  const { t } = useI18n();
  const [engagements, setEngagements] = useState<Engagement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.engagements().then((r) => setEngagements(r.engagements), (e: unknown) => setError(e instanceof ApiError ? e.message : t('error.generic')));
  }, [api, t]);

  return (
    <section className="panel">
      <h1>{t('engagements.title')}</h1>
      {error && <Notice tone="error">{error}</Notice>}
      {engagements === null && !error && <p>{t('common.loading')}</p>}
      {engagements?.length === 0 && <p className="muted">{t('engagements.empty')}</p>}
      <ul className="cards">
        {engagements?.map((e) => (
          <li key={e.id} className="card">
            <div>
              <strong>{e.code}</strong> <span className="pill pill-neutral">{e.stage}</span>
              <p className="muted small">{t('engagements.period', { start: e.periodStart, end: e.periodEnd })} · {e.reportingCurrency}</p>
            </div>
            <Link className="button" href={`/engagements/${e.id}`}>{t('engagements.open')}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
