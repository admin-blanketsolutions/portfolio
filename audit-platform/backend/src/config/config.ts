import { z } from 'zod';

/** Secrets may be given as "base64:<bytes>" (preferred) or as raw UTF-8. */
export function decodeSecret(value: string): Buffer {
  return value.startsWith('base64:') ? Buffer.from(value.slice(7), 'base64') : Buffer.from(value, 'utf8');
}

const secret = z
  .string()
  .refine((v) => decodeSecret(v).length >= 32, 'must decode to at least 32 bytes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().startsWith('postgres'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  CTX_SIGNING_KEY_ID: z.string().regex(/^[a-z0-9-]{1,32}$/),
  CTX_SIGNING_KEY: secret,
  CTX_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(60),
  JOB_ENVELOPE_KEY: secret,
  OIDC_AUDIENCE: z.string().min(1),
  TENANT_BASE_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/),
  DEPLOYMENT_REGION: z.string().min(1),

  // --- TB ingestion (Phase 3) ---
  TB_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).max(100 * 1024 * 1024).default(25 * 1024 * 1024),
  /** Directory holding the sandboxed parser package (audit-platform/parser). */
  TB_PARSER_DIR: z.string().min(1).default('../parser'),
  /** Interpreter with the parser's requirements (defaults to the parser's own virtualenv). */
  TB_PARSER_PYTHON: z.string().min(1).optional(),
  TB_PARSER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(90_000),
  /** 'subprocess' (development/tests) or 'container' (network-less single-use container; required in production). */
  TB_PARSER_DRIVER: z.enum(['subprocess', 'container']).default('subprocess'),
  /** Parser image built from parser/Dockerfile; pinned by digest in production. Never pulled at parse time. */
  TB_PARSER_IMAGE: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,254}$/).optional(),
  TB_PARSER_CONTAINER_CLI: z.enum(['docker', 'podman']).default('docker'),
  /** OCI runtime for parser containers, e.g. runsc (gVisor). */
  TB_PARSER_RUNTIME: z.string().regex(/^[a-z0-9_.-]{1,32}$/).optional(),
  TB_PARSER_MEMORY_MB: z.coerce.number().int().min(128).max(8192).default(1536),
  /** 'memory' is for development and tests only; production must use 's3'. */
  OBJECT_STORE_DRIVER: z.enum(['memory', 's3']).default('memory'),
  TB_SOURCE_BUCKET: z.string().regex(/^[a-z0-9.-]{3,63}$/).default('audit-tb-sources'),
  /** Defaults to DEPLOYMENT_REGION: client files stay in the deployment's region. */
  S3_REGION: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
  /** S3-compatible endpoint for tests, or an https VPC interface endpoint. */
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** AWS account that must own the bucket (S3 refuses requests otherwise). Required in production. */
  S3_EXPECTED_BUCKET_OWNER: z.string().regex(/^\d{12}$/).optional(),
  /** Per-tenant KMS key; `{tenantId}` is replaced. Key policies must bind each key to its tenant. */
  TENANT_KMS_KEY_TEMPLATE: z.string().regex(/^[A-Za-z0-9:/_-]*\{tenantId\}[A-Za-z0-9:/_-]*$/).default('alias/audit-tenant-{tenantId}'),
  /** LLM stage of the mapping cascade. Also requires platform.tenants.llm_mapping_allowed per tenant. */
  MAPPING_LLM_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MAPPING_LLM_MODEL: z.string().min(1).default('claude-opus-5'),
  MAPPING_LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  MAPPING_LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(50),
}).superRefine((c, ctx) => {
  const need = (ok: boolean, path: string, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', path: [path], message }); };
  if (c.TB_PARSER_DRIVER === 'container') need(c.TB_PARSER_IMAGE !== undefined, 'TB_PARSER_IMAGE', 'is required for the container driver');
  if (c.NODE_ENV !== 'production') return;
  need(c.TB_PARSER_DRIVER === 'container', 'TB_PARSER_DRIVER', "must be 'container' in production");
  need(c.TB_PARSER_IMAGE === undefined || /@sha256:[0-9a-f]{64}$/.test(c.TB_PARSER_IMAGE), 'TB_PARSER_IMAGE', 'must be pinned by digest (name@sha256:...) in production');
  need(c.OBJECT_STORE_DRIVER === 's3', 'OBJECT_STORE_DRIVER', "must be 's3' in production");
  need(c.S3_EXPECTED_BUCKET_OWNER !== undefined, 'S3_EXPECTED_BUCKET_OWNER', 'is required in production');
  need(c.S3_ENDPOINT === undefined || c.S3_ENDPOINT.startsWith('https://'), 'S3_ENDPOINT', 'must be https in production');
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Validates the environment once at boot. Error messages name the offending
 * variables but never echo their values (they may be secrets).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${fields.join('\n  ')}`);
  }
  return parsed.data;
}
