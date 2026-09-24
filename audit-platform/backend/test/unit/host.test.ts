import { describe, expect, it } from 'vitest';
import { tenantSlugFromHost } from '../../src/tenancy/host.js';

describe('tenantSlugFromHost', () => {
  const base = 'app.example.com';
  it.each([
    ['alpha-audit.app.example.com', 'alpha-audit'],
    ['ALPHA-AUDIT.App.Example.com.', 'alpha-audit'],
  ])('%s -> %s', (host, slug) => expect(tenantSlugFromHost(host, base)).toBe(slug));

  it.each([
    'app.example.com',                  // apex
    'a.b.app.example.com',              // nested
    'alpha-audit.app.example.com.evil.io',
    'alpha-auditapp.example.com',       // no dot boundary
    '-bad.app.example.com',
    'xn--80ak6aa92e.app.example.com.attacker', // look-alike suffix
    '10.0.0.1',
    undefined,
  ])('rejects %s', (host) => expect(tenantSlugFromHost(host, base)).toBeNull());
});
