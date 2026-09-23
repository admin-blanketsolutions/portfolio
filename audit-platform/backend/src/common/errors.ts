export type DomainErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'misdirected'
  | 'conflict'
  | 'invalid'
  | 'unavailable'
  | 'internal';

/**
 * The only error shape that reaches clients. Messages are chosen by us, never
 * copied from the driver: PostgreSQL `detail` strings contain key values
 * ("Key (tenant_id, id)=(...) is not present") and are a classic leakage
 * vector across tenants and to attackers probing for existence.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly retryable = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface PgLikeError {
  code: string;
  message: string;
  constraint?: string;
}

function isPgError(e: unknown): e is PgLikeError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    && /^[0-9A-Z]{5}$/.test((e as { code: string }).code);
}

export function isRetryablePgError(e: unknown): boolean {
  return isPgError(e) && (e.code === '40001' || e.code === '40P01');
}

/**
 * Map SQLSTATE -> DomainError. Codes raised by our own triggers (55000
 * object_not_in_prerequisite_state, 23514 without a named constraint) carry
 * messages written for users; everything else gets a generic message.
 */
export function translatePgError(e: unknown): unknown {
  if (e instanceof DomainError || !isPgError(e)) return e;
  switch (e.code) {
    case '28000':
      return new DomainError('unauthenticated', 'Session context was rejected.', false, e);
    case '42501':
      return new DomainError('forbidden', 'You are not permitted to perform this action.', false, e);
    case '55000':
      return new DomainError('conflict', e.message, false, e);
    case '23514':
      return new DomainError('invalid', e.constraint ? 'Validation failed.' : e.message, false, e);
    case '23505':
      return new DomainError('conflict', 'A record with the same identity already exists.', false, e);
    case '23503':
      return new DomainError('invalid', 'A referenced record does not exist.', false, e);
    case '22P02':
    case '22007':
    case '22008':
      return new DomainError('invalid', 'Malformed input.', false, e);
    case '40001':
    case '40P01':
      return new DomainError('conflict', 'Concurrent update detected; please retry.', true, e);
    case '57014':
      return new DomainError('unavailable', 'The operation timed out.', true, e);
    default:
      return new DomainError('internal', 'Internal error.', false, e);
  }
}
