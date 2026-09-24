import { describe, expect, it } from 'vitest';
import { DomainError, translatePgError } from '../../src/common/errors.js';

const pgErr = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

describe('translatePgError', () => {
  it('never forwards driver detail for FK / unique violations', () => {
    const fk = translatePgError(pgErr('23503', 'insert violates foreign key', {
      detail: 'Key (tenant_id, client_id)=(1111..., 2222...) is not present in table "clients".',
    })) as DomainError;
    expect(fk.code).toBe('invalid');
    expect(fk.message).not.toMatch(/Key|tenant_id|2222/);
  });

  it('maps RLS / privilege failures to forbidden with a generic message', () => {
    const e = translatePgError(pgErr('42501', 'new row violates row-level security policy for table "workpapers"')) as DomainError;
    expect(e.code).toBe('forbidden');
    expect(e.message).not.toMatch(/workpapers|row-level/);
  });

  it('passes through our own trigger messages (they are written for users)', () => {
    const e = translatePgError(pgErr('55000', 'entry #3 is posted and immutable; post a reversing entry instead')) as DomainError;
    expect(e.code).toBe('conflict');
    expect(e.message).toMatch(/reversing entry/);
  });

  it('hides named CHECK constraint internals', () => {
    const e = translatePgError(pgErr('23514', 'new row for relation "engagements" violates check constraint "engagements_check3"', { constraint: 'engagements_check3' })) as DomainError;
    expect(e.message).toBe('Validation failed.');
  });

  it('flags serialization failures as retryable and context failures as unauthenticated', () => {
    expect((translatePgError(pgErr('40001', 'could not serialize')) as DomainError).retryable).toBe(true);
    expect((translatePgError(pgErr('28000', 'tenant context signature invalid')) as DomainError).code).toBe('unauthenticated');
  });
});
