import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithTenantContext, type TenantContext } from './tenant-context.js';
import { REQUEST_TENANT_CONTEXT } from './tokens.js';

/**
 * Enters the request's TenantContext for the rest of the pipeline.
 *
 * `next.handle()` MUST be called inside `runWithTenantContext`: Nest binds the
 * handler's async context (AsyncResource.bind) at the moment handle() is
 * called, so calling it outside and only subscribing inside would run the
 * controller without a tenant context — which TenantDb would then refuse.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ [REQUEST_TENANT_CONTEXT]?: TenantContext }>();
    const ctx = req[REQUEST_TENANT_CONTEXT];
    if (!ctx) return next.handle(); // @Public() routes
    return new Observable((subscriber) =>
      runWithTenantContext(ctx, () => next.handle().subscribe(subscriber)),
    );
  }
}
