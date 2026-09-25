'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

export default function AuthCallbackPage() {
  const { completeRedirect } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;          // the code is single-use (React strict mode runs effects twice)
    done.current = true;
    completeRedirect().then((to) => router.replace(to), () => setFailed(true));
  }, [completeRedirect, router]);
  return failed ? <Notice tone="error">{t('error.generic')}</Notice> : <p>{t('auth.signingIn')}</p>;
}
