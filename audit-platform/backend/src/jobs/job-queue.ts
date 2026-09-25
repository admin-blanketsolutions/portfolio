import { withoutTenantContext } from '../tenancy/tenant-context.js';
import type { JobEnvelope } from './job-envelope.js';

export type JobHandler = (envelope: JobEnvelope<unknown>) => Promise<void>;

export interface JobQueue {
  enqueue(envelope: JobEnvelope<unknown>): Promise<void>;
}

/**
 * Single-process queue (development, tests, small single-node installs).
 * Production swaps in SQS/Redis behind the same interface; the envelope is
 * HMAC-sealed either way, so the transport is never trusted.
 *
 * Handlers are started OUTSIDE any tenant context: the enqueueing request's
 * AsyncLocalStorage context must not leak into the job (the handler derives
 * its own from the verified envelope).
 */
export class InProcessJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly onError: (err: unknown, envelope: JobEnvelope<unknown>) => void = () => {}) {}

  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) throw new Error(`handler for ${type} already registered`);
    this.handlers.set(type, handler);
  }

  async enqueue(envelope: JobEnvelope<unknown>): Promise<void> {
    const handler = this.handlers.get(envelope.type);
    if (!handler) throw new Error(`no handler for job type ${envelope.type}`);
    const run = withoutTenantContext(() => new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => withoutTenantContext(() => handler(envelope)))
      .catch((err: unknown) => this.onError(err, envelope)));
    const tracked = run.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Resolves when every job enqueued so far (and any they enqueue) has finished. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }
}
