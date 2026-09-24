import { Controller, Get, Inject, Module } from '@nestjs/common';
import type pg from 'pg';
import { Public } from '../../tenancy/decorators.js';
import { PG_POOL } from '../../tenancy/tokens.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the DB is reachable. Tenant-neutral query, no context. */
  @Public()
  @Get('ready')
  async ready() {
    await this.pool.query('SELECT 1');
    return { status: 'ready' };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
