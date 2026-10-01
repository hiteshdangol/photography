import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (server/config -> server -> repo root) */
export const SERVER_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// `import 'dotenv/config'` would resolve `.env` against process.cwd(), which is
// the server/ workspace when launched through npm --workspace but the repository
// root when run directly. Load both, root first, without overriding real env vars.
// This must happen before anything reads process.env.
for (const candidate of [path.join(REPO_ROOT, '.env'), path.join(SERVER_ROOT, '.env'), '.env']) {
  dotenv.config({ path: candidate, quiet: true });
}

export const UPLOAD_ROOT = path.resolve(SERVER_ROOT, process.env.UPLOAD_DIR ?? './uploads');

/** `"true" | "1" | "yes"` -> true. Anything else false. */
const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(5000, 1, 65535),
    API_PREFIX: z.string().default('/api'),
    CLIENT_URL: z.string().default('http://localhost:5173'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

    MONGO_URI: z.string().default('mongodb://localhost:27017/lensflow'),
    DB_STRICT: bool(false),

    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
    JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    BCRYPT_ROUNDS: int(12, 4, 15),

    UPLOAD_DIR: z.string().default('./uploads'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    MAX_UPLOAD_MB: int(25, 1, 500),
    MAX_FILES_PER_REQUEST: int(60, 1, 500),
    GALLERY_WIDTH: int(1600, 320, 6000),
    THUMB_WIDTH: int(400, 80, 1600),
    IMAGE_FORMAT: z.enum(['webp', 'jpeg']).default('webp'),

    EMAIL_HOST: z.string().optional().default(''),
    EMAIL_PORT: int(587, 1, 65535),
    EMAIL_SECURE: bool(false),
    EMAIL_USER: z.string().optional().default(''),
    EMAIL_PASSWORD: z.string().optional().default(''),
    EMAIL_FROM: z.string().default('LensFlow <no-reply@lensflow.test>'),

    PAYMENT_PROVIDER: z.enum(['mock', 'esewa', 'khalti']).default('mock'),
    CURRENCY: z.string().default('NPR'),
    PAYMENT_SESSION_TTL: int(1800, 60, 86400),

    ESEWA_MERCHANT_ID: z.string().optional().default(''),
    ESEWA_SECRET: z.string().optional().default(''),
    ESEWA_PRODUCT_CODE: z.string().default('EPAYTEST'),

    KHALTI_SECRET_KEY: z.string().optional().default(''),
    KHALTI_PUBLIC_KEY: z.string().optional().default(''),

    ALLOW_CLIENT_DOWNLOADS: bool(true),
    ALLOW_ORIGINAL_DOWNLOADS: bool(false),
    CRON_ENABLED: bool(true),
    NOTIFICATION_RETENTION_DAYS: int(180, 1, 3650),
    MAX_PAGE_SIZE: int(100, 1, 500),

    SEED_PHOTOS_PER_PROJECT: int(48, 0, 2000),
    SEED_RANDOM_SEED: int(1337, 0, 2 ** 31),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production') {
      if (value.JWT_SECRET.startsWith('replace-me')) {
        ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'must be changed in production' });
      }
      if (value.JWT_SECRET === value.JWT_REFRESH_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_REFRESH_SECRET'],
          message: 'must differ from JWT_SECRET',
        });
      }
      if (value.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message: 'local disk storage is not supported in production; use s3',
        });
      }
    }
  })
  .transform((value) => {
    const credentialsPresent =
      value.PAYMENT_PROVIDER === 'esewa'
        ? Boolean(value.ESEWA_SECRET && value.ESEWA_MERCHANT_ID)
        : value.PAYMENT_PROVIDER === 'khalti'
          ? Boolean(value.KHALTI_SECRET_KEY)
          : true;
    return {
      ...value,
      isProduction: value.NODE_ENV === 'production',
      isTest: value.NODE_ENV === 'test',
      hasEmailTransport: Boolean(value.EMAIL_HOST && value.EMAIL_USER),
      /** Effective provider: falls back to the mock provider when credentials are absent. */
      effectivePaymentProvider: credentialsPresent
        ? value.PAYMENT_PROVIDER
        : ('mock' as 'mock' | 'esewa' | 'khalti'),
      paymentCredentialsPresent: credentialsPresent,
      corsOrigins: [value.CLIENT_URL],
      maxUploadBytes: value.MAX_UPLOAD_MB * 1024 * 1024,
    };
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(
    `\nInvalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in the values.\n`,
  );
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}
