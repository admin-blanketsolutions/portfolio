import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  MissingTenantContextError,
  TenantContextSwitchError,
  currentTenantContext,
  requireTenantContext,
  runWithTenantContext,
  withoutTenantContext,
} from '../../src/tenancy/tenant-context.js';
import { TENANT_A, TENANT_B, USER_A, USER_B, ctx } from './fixtures.js';

describe('tenant context (AsyncLocalStorage)', () => {
  it('fails closed outside a context', () => {
    expect(currentTenantContext()).toBeUndefined();
    expect(() => requireTenantContext()).toThrow(MissingTenantContextError);
  });

  it('keeps 400 interleaved async flows for two tenants fully isolated', async () => {
    const flows = Array.from({ length: 400 }, (_, i) => {
      const c = i % 2 === 0 ? ctx(TENANT_A, USER_A) : ctx(TENANT_B, USER_B);
      return runWithTenantContext(c, async () => {
        const seen: string[] = [];
        for (let hop = 0; hop < 5; hop++) {
          await sleep(Math.random() * 3);
          await Promise.resolve();
          seen.push(requireTenantContext().tenantId);
        }
        return { expected: c.tenantId, seen };
      });
    });
    for (const { expected, seen } of await Promise.all(flows)) {
      expect(new Set(seen)).toEqual(new Set([expected]));
    }
  });

  it('refuses to switch tenant or user inside an active context', () => {
    runWithTenantContext(ctx(TENANT_A, USER_A), () => {
      expect(() => runWithTenantContext(ctx(TENANT_B, USER_B), () => 1)).toThrow(TenantContextSwitchError);
      expect(() => runWithTenantContext(ctx(TENANT_A, USER_B), () => 1)).toThrow(TenantContextSwitchError);
      expect(runWithTenantContext(ctx(TENANT_A, USER_A), () => 42)).toBe(42);
    });
  });

  it('allows explicit exit for platform-level iteration', () => {
    runWithTenantContext(ctx(TENANT_A, USER_A), () => {
      withoutTenantContext(() => {
        expect(currentTenantContext()).toBeUndefined();
        expect(runWithTenantContext(ctx(TENANT_B, USER_B), () => requireTenantContext().tenantId)).toBe(TENANT_B);
      });
      expect(requireTenantContext().tenantId).toBe(TENANT_A);
    });
  });

  it('freezes the context', () => {
    runWithTenantContext(ctx(TENANT_A, USER_A), () => {
      const c = requireTenantContext() as { tenantId: string };
      expect(() => { c.tenantId = TENANT_B; }).toThrow(TypeError);
    });
  });
});
