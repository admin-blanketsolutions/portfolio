import type { TenantContext } from '../../src/tenancy/tenant-context.js';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const KEY = Buffer.from('unit-test-key-0123456789abcdef-0123456789', 'utf8');

export function ctx(tenantId: string, userId: string, over: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId,
    tenantSlug: tenantId === TENANT_A ? 'alpha-audit' : 'beta-audit',
    userId,
    kind: 'staff',
    isFirmAdmin: false,
    homeRegion: 'me-central-1',
    requestId: 'req-00000001',
    ...over,
  };
}
