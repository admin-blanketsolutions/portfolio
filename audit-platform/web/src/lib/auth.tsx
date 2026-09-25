'use client';

import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClient } from './api';

/*
 * Sign-in against the TENANT'S OWN IdP (authorization code + PKCE). The
 * issuer and client id come from GET /api/auth/config for this host, so one
 * deployment serves every firm without a per-tenant build.
 *
 * Tokens live in memory only (not localStorage/sessionStorage): a script
 * injected into the page cannot read a token from storage after the fact,
 * and closing the tab ends the session. A reload re-uses the IdP session.
 *
 * NEXT_PUBLIC_AUTH_MODE=dev-token replaces the IdP with a pasted token for
 * local development and browser tests; production builds use 'oidc'.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api';
const MODE = process.env.NEXT_PUBLIC_AUTH_MODE === 'dev-token' ? 'dev-token' : 'oidc';

type Status = 'loading' | 'signed-out' | 'signed-in' | 'unavailable';

export interface Auth {
  status: Status;
  mode: 'oidc' | 'dev-token';
  api: ApiClient;
  signIn: () => Promise<void>;
  signInWithToken: (token: string) => void;
  signOut: () => Promise<void>;
  completeRedirect: () => Promise<string>;
  expired: boolean;
}

/** Exported for tests, which provide a fake API through it. */
export const AuthContext = createContext<Auth | null>(null);
let sharedManager: UserManager | null = null;   // survives client-side navigation (callback -> app)
let devToken: string | null = null;

async function manager(): Promise<UserManager | null> {
  if (sharedManager) return sharedManager;
  const cfg = await new ApiClient(API_BASE, async () => null).authConfig().catch(() => null);
  if (!cfg) return null;
  sharedManager = new UserManager({
    authority: cfg.issuer,
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code',
    scope: cfg.scope,
    extraQueryParams: { audience: cfg.audience },
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    automaticSilentRenew: false,
  });
  return sharedManager;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [expired, setExpired] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const token = useCallback(async () => {
    if (MODE === 'dev-token') return devToken;
    const user = await (await manager())?.getUser();
    return user && !user.expired ? user.access_token : null;
  }, []);

  const api = useMemo(() => new ApiClient(API_BASE, token, () => {
    if (statusRef.current === 'signed-in') setExpired(true);
    setStatus('signed-out');
  }), [token]);

  useEffect(() => {
    void (async () => {
      if (MODE === 'dev-token') { setStatus(devToken ? 'signed-in' : 'signed-out'); return; }
      const m = await manager();
      if (!m) { setStatus('unavailable'); return; }
      const user = await m.getUser();
      setStatus(user && !user.expired ? 'signed-in' : 'signed-out');
    })();
  }, []);

  const value = useMemo<Auth>(() => ({
    status, mode: MODE, api, expired,
    signIn: async () => {
      const m = await manager();
      if (!m) { setStatus('unavailable'); return; }
      await m.signinRedirect({ state: { returnTo: window.location.pathname } });
    },
    signInWithToken: (t: string) => { devToken = t.trim() || null; setExpired(false); setStatus(devToken ? 'signed-in' : 'signed-out'); },
    signOut: async () => {
      devToken = null;
      const m = MODE === 'oidc' ? await manager() : null;
      await m?.removeUser();
      setStatus('signed-out');
    },
    completeRedirect: async () => {
      const m = await manager();
      if (!m) throw new Error('sign-in unavailable');
      const user = await m.signinRedirectCallback();
      setStatus('signed-in');
      setExpired(false);
      const returnTo = (user.state as { returnTo?: string } | undefined)?.returnTo;
      // Only same-app relative paths: no open redirect through the state parameter.
      return typeof returnTo === 'string' && /^\/(?!\/)[\w\-/]*$/.test(returnTo) ? returnTo : '/';
    },
  }), [status, api, expired]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
