'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import type { Me } from '@/lib/types';
import { Notice } from './ui';

export function AppShell({ children }: { children: ReactNode }) {
  const { status, api, signOut } = useAuth();
  const { t, toggle, locale } = useI18n();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (status === 'signed-in') api.me().then(setMe, () => setMe(null));
    else setMe(null);
  }, [status, api]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">{t('app.title')}</Link>
        <div className="topbar-actions">
          {me && <span className="who">{(locale === 'ar' && me.displayNameAr) || me.displayName} · {me.tenant}</span>}
          <button type="button" className="button ghost" onClick={toggle} lang={locale === 'ar' ? 'en' : 'ar'}>{t('app.language')}</button>
          {status === 'signed-in' && <button type="button" className="button ghost" onClick={() => void signOut()}>{t('app.signOut')}</button>}
        </div>
      </header>
      {/* The OIDC callback must run while still signed out. */}
      <main className="content">{status === 'signed-in' || pathname.startsWith('/auth/') ? children : <SignIn />}</main>
    </div>
  );
}

function SignIn() {
  const { status, mode, signIn, signInWithToken, signOut, expired } = useAuth();
  const { t } = useI18n();
  const [token, setToken] = useState('');
  if (status === 'loading') return <p>{t('common.loading')}</p>;
  if (status === 'unavailable') return <Notice tone="error">{t('auth.unavailable')}</Notice>;
  if (status === 'no-access') {
    return (
      <section className="panel signin">
        <Notice tone="error">{t('auth.noAccess')}</Notice>
        <button type="button" className="button" onClick={() => void signOut()}>{t('auth.switchAccount')}</button>
      </section>
    );
  }
  return (
    <section className="panel signin">
      {expired && <Notice tone="info">{t('auth.expired')}</Notice>}
      {mode === 'oidc' ? (
        <button type="button" className="button primary" onClick={() => void signIn()}>{t('auth.signIn')}</button>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); signInWithToken(token); }}>
          <label className="field">
            <span>{t('auth.devToken')}</span>
            <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={4} spellCheck={false} data-testid="dev-token" />
          </label>
          <button type="submit" className="button primary">{t('auth.devTokenSubmit')}</button>
        </form>
      )}
    </section>
  );
}
