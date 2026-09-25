import type { CoaAccount, Engagement, LineFilter, LinesPage, Me, TbImport, TrialBalance } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AuthConfig { tenant: string; issuer: string; clientId: string; audience: string; scope: string }

type TokenSource = () => Promise<string | null>;

/**
 * Thin, typed client for the tenant API on the same origin. The tenant is
 * never sent explicitly: the API derives it from the host and the token.
 * Error bodies are the API's own safe envelope ({error, message}).
 */
export class ApiClient {
  constructor(private readonly base: string, private readonly token: TokenSource, private readonly onUnauthenticated: () => void = () => {}) {}

  private async request<T>(method: string, path: string, init: { json?: unknown; body?: Blob | ArrayBuffer; contentType?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers['content-type'] = init.contentType ?? 'application/octet-stream';
      body = init.body;
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), credentials: 'omit', cache: 'no-store' });
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      if (res.status === 401) this.onUnauthenticated();
      const err = (data ?? {}) as { error?: string; message?: string };
      throw new ApiError(res.status, err.error ?? 'http_error', err.message ?? res.statusText);
    }
    return data as T;
  }

  authConfig = () => this.request<AuthConfig>('GET', '/auth/config');
  me = () => this.request<Me>('GET', '/me');
  engagements = () => this.request<{ tenant: string; engagements: Engagement[] }>('GET', '/engagements');
  imports = (engagementId: string) => this.request<{ imports: TbImport[] }>('GET', `/engagements/${encodeURIComponent(engagementId)}/tb-imports`);
  importById = (id: string) => this.request<TbImport>('GET', `/tb-imports/${encodeURIComponent(id)}`);

  upload(engagementId: string, file: File): Promise<TbImport> {
    const name = file.name.toLowerCase();
    const type = name.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return this.request<TbImport>('POST', `/engagements/${encodeURIComponent(engagementId)}/tb-imports?filename=${encodeURIComponent(file.name)}`,
      { body: file, contentType: type });
  }

  trialBalance = (id: string) => this.request<TrialBalance>('GET', `/trial-balances/${encodeURIComponent(id)}`);
  lines = (id: string, opts: { afterLine?: number; limit?: number; status?: LineFilter } = {}) => {
    const q = new URLSearchParams({ afterLine: String(opts.afterLine ?? 0), limit: String(opts.limit ?? 200), status: opts.status ?? 'all' });
    return this.request<LinesPage>('GET', `/trial-balances/${encodeURIComponent(id)}/lines?${q}`);
  };
  accept = (mappingId: string, acknowledgeFlags = false) =>
    this.request<{ mappingId: string; status: string }>('POST', `/mappings/${encodeURIComponent(mappingId)}/accept`, { json: { acknowledgeFlags } });
  reject = (mappingId: string) => this.request<{ mappingId: string }>('POST', `/mappings/${encodeURIComponent(mappingId)}/reject`, { json: {} });
  bulkAccept = (tbId: string, mappingIds: string[]) =>
    this.request<{ accepted: string[]; skipped: Array<{ mappingId: string; reason: string }> }>('POST', `/trial-balances/${encodeURIComponent(tbId)}/bulk-accept`, { json: { mappingIds } });
  manualMapping = (tbId: string, lineId: string, coaCode: string, rationale: string) =>
    this.request<{ mappingId: string }>('POST', `/trial-balances/${encodeURIComponent(tbId)}/lines/${encodeURIComponent(lineId)}/mapping`, { json: { coaCode, rationale } });
  lock = (tbId: string) => this.request<{ status: string; lockedAt: string }>('POST', `/trial-balances/${encodeURIComponent(tbId)}/lock`, { json: {} });
  coa = () => this.request<{ accounts: CoaAccount[] }>('GET', '/coa?postable=true');
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
