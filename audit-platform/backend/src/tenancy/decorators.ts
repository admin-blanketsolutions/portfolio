import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { requireTenantContext, type TenantContext } from './tenant-context.js';

export const IS_PUBLIC = 'tenancy:isPublic';

/** Opt a route out of authentication (health checks only). Everything else is tenant-bound by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Inject the active TenantContext into a handler parameter. */
export const Ctx = createParamDecorator((_data: unknown, _ctx: ExecutionContext): TenantContext => requireTenantContext());
