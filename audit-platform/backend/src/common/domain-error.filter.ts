import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError, type DomainErrorCode } from './errors.js';
import { currentTenantContext } from '../tenancy/tenant-context.js';

const STATUS: Record<DomainErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  misdirected: 421,
  conflict: 409,
  invalid: 422,
  unavailable: 503,
  internal: 500,
};

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

/**
 * Last line of the response path. Anything that is not a DomainError or a
 * Nest HttpException becomes an opaque 500; the original error is logged
 * server-side with tenant/request correlation but never sent to the client.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ResponseLike>();
    const ctx = currentTenantContext();

    if (exception instanceof DomainError) {
      const status = STATUS[exception.code];
      if (status >= 500) this.log(exception.cause ?? exception, ctx);
      res.status(status).json({ error: exception.code, message: exception.message, requestId: ctx?.requestId });
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({ error: 'http_error', message: exception.message });
      return;
    }
    this.log(exception, ctx);
    res.status(500).json({ error: 'internal', message: 'Internal error.', requestId: ctx?.requestId });
  }

  private log(err: unknown, ctx: ReturnType<typeof currentTenantContext>): void {
    const e = err as { name?: string; code?: string; message?: string };
    console.error(JSON.stringify({
      level: 'error',
      tenantId: ctx?.tenantId,
      requestId: ctx?.requestId,
      name: e?.name,
      code: e?.code,
      message: e?.message,
    }));
  }
}
