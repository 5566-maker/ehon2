import { z } from 'zod';

/**
 * Centralized configuration. Everything secret comes from environment
 * variables — nothing is read from files and nothing is hard-coded.
 *
 * On startup the process validates the environment and exits with a clear
 * list of missing/invalid variables instead of failing later at runtime.
 */

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default('/data'),
  APP_NAME: z.string().min(1).default('Yomikiki Books'),
  APP_BASE_URL: z.string().default(''),

  // ---- required secrets ----
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  AUTH_USERNAME: z.string().min(1, 'AUTH_USERNAME is required'),
  AUTH_PASSWORD_HASH: z.string().min(1, 'AUTH_PASSWORD_HASH is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  // ---- session ----
  SESSION_COOKIE_NAME: z.string().min(1).default('ehon2_session'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(720),

  // ---- OpenAI models / voices (config-driven, see technical spec) ----
  OPENAI_VISION_MODEL: z.string().min(1).default('gpt-4o'),
  // Optional one-shot fallback for page enrichment only: if enrichment with
  // OPENAI_VISION_MODEL fails with a provider error or an invalid AI
  // response, it is retried once with this model. Google Vision OCR is
  // never retried.
  OPENAI_ENRICHMENT_FALLBACK: z.string().min(1).optional(),
  OPENAI_TTS_MODEL: z.string().min(1).default('gpt-4o-mini-tts'),
  DEFAULT_JA_VOICE: z.string().min(1).default('alloy'),
  DEFAULT_ZH_VOICE: z.string().min(1).default('echo'),
  DEFAULT_EN_VOICE: z.string().min(1).default('verse'),

  // ---- OCR provider (Google Vision owns geometry, OpenAI owns language) ----
  // Kept optional so existing deployments keep starting without a Google key;
  // page processing fails with a clear message until the key is set.
  GOOGLE_VISION_API_KEY: z.string().min(1).optional(),
  GOOGLE_VISION_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  OCR_PROVIDER: z.enum(['google', 'openai-legacy']).default('google'),
  // Abort a hung Google Vision request instead of leaving pages stuck in
  // "processing".
  GOOGLE_VISION_TIMEOUT_MS: z.coerce.number().int().positive().max(300000).default(30000),
  // Client-level timeout for OpenAI API calls (enrichment, cover analysis,
  // TTS). The SDK default is 10 minutes; 60s keeps failures visible fast.
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().max(600000).default(60000),

  // ---- uploads / images ----
  IMAGE_MAX_DIM: z.coerce.number().int().min(256).max(4096).default(1600),
  IMAGE_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
  UPLOAD_MAX_MB: z.coerce.number().positive().max(100).default(15),
  UPLOAD_MAX_FILES: z.coerce.number().int().min(1).max(100).default(30),

  // ---- TTS ----
  AUDIO_MAX_CHARS: z.coerce.number().int().min(100).max(4096).default(4000),

  // ---- TTS provider (Kokoro primary, OpenAI fallback) ----
  TTS_PROVIDER: z.enum(['kokoro', 'openai']).default('kokoro'),
  KOKORO_BASE_URL: z
    .string()
    .min(1)
    .default('http://kokoro-fastapi-cpu.zeabur.internal:8880'),
  KOKORO_TTS_MODEL: z.string().min(1).default('kokoro'),
  // Optional per-language Kokoro voice overrides; built-in defaults are
  // validated against the Kokoro voice list (jf_*/zf_*/af_*).
  KOKORO_JA_VOICE: z.string().min(1).optional(),
  KOKORO_ZH_VOICE: z.string().min(1).optional(),
  KOKORO_EN_VOICE: z.string().min(1).optional(),
  // Default TTS speed (0.5-2x); per-language overrides win over the global.
  TTS_SPEED: z.coerce.number().min(0.5).max(2).default(1),
  TTS_SPEED_JA: z.coerce.number().min(0.5).max(2).optional(),
  TTS_SPEED_ZH: z.coerce.number().min(0.5).max(2).optional(),
  TTS_SPEED_EN: z.coerce.number().min(0.5).max(2).optional(),

  // ---- optional overrides ----
  PUBLIC_DIR: z.string().min(1).optional(),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    console.error(
      [
        'Invalid environment configuration. Refusing to start.',
        'Fix the following and restart:',
        ...missing,
        '',
        'See .env.example for a template.',
      ].join('\n'),
    );
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cached env (used by tests). */
export function resetEnvCache(): void {
  cached = null;
}
