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
