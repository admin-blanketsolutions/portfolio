import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '@/lib/api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }));
  return calls;
}

describe('ApiClient', () => {
  it('sends the bearer token, never cookies, and targets the same-origin API', async () => {
    const calls = stubFetch(200, { accounts: [] });
    await new ApiClient('/api', async () => 'tok-1').coa();
    expect(calls[0]!.url).toBe('/api/coa?postable=true');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(calls[0]!.init.credentials).toBe('omit');
  });

  it('surfaces the API error envelope and reports 401s', async () => {
    stubFetch(409, { error: 'conflict', message: 'This suggestion is flagged.' });
    const err = await new ApiClient('/api', async () => 't').accept('m1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', message: 'This suggestion is flagged.' });

    stubFetch(401, { error: 'unauthenticated', message: 'Authentication required.' });
    const onUnauth = vi.fn();
    await new ApiClient('/api', async () => 't', onUnauth).me().catch(() => undefined);
    expect(onUnauth).toHaveBeenCalledOnce();
  });

  it('uploads the raw file with a content type derived from its extension and an encoded name', async () => {
    const calls = stubFetch(202, { id: 'i1' });
    const file = new File(['Code,Name\n'], 'TB 2025 ميزان.csv');
    await new ApiClient('/api', async () => 't').upload('e1', file);
    expect(calls[0]!.url).toBe(`/api/engagements/e1/tb-imports?filename=${encodeURIComponent('TB 2025 ميزان.csv')}`);
    expect(calls[0]!.init.headers).toMatchObject({ 'content-type': 'text/csv' });
    expect(calls[0]!.init.body).toBe(file);
  });

  it('encodes path segments', async () => {
    const calls = stubFetch(200, {});
    await new ApiClient('/api', async () => 't').trialBalance('../x?y');
    expect(calls[0]!.url).toBe('/api/trial-balances/..%2Fx%3Fy');
  });
});
