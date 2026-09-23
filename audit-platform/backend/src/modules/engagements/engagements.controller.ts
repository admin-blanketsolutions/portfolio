import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { TenantDb } from '../../database/tenant-db.js';
import { Ctx } from '../../tenancy/decorators.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { TENANT_DB } from '../../tenancy/tokens.js';
import { EngagementsRepository, type EngagementStage } from './engagements.repository.js';

const EngagementId = z.uuid();
const StageChange = z.object({
  stage: z.enum(['planning', 'fieldwork', 'review', 'reporting', 'completed', 'archived']),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError('invalid', 'Malformed request.');
  return r.data;
}

@Controller('engagements')
export class EngagementsController {
  private readonly repo = new EngagementsRepository();

  constructor(@Inject(TENANT_DB) private readonly db: TenantDb) {}

  @Get()
  async list(@Ctx() ctx: TenantContext) {
    const engagements = await this.db.transaction((tx) => this.repo.list(tx), { readOnly: true });
    return { tenant: ctx.tenantSlug, engagements };
  }

  @Get(':id/fs-rollup')
  async rollup(@Param('id') id: string) {
    const engagementId = parse(EngagementId, id);
    return this.db.transaction((tx) => this.repo.fsRollup(tx, engagementId), { readOnly: true, isolation: 'repeatable read' });
  }

  @Post(':id/stage')
  async changeStage(@Param('id') id: string, @Body() body: unknown) {
    const engagementId = parse(EngagementId, id);
    const { stage } = parse(StageChange, body);
    const updated: EngagementStage | null = await this.db.transaction((tx) => this.repo.changeStage(tx, engagementId, stage));
    // RLS makes foreign / walled engagements invisible: same answer as "does not exist".
    if (!updated) throw new DomainError('not_found', 'Not found.');
    return { id: engagementId, stage: updated };
  }
}
