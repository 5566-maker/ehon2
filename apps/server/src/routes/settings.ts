import { Hono } from 'hono';
import {
  ErrorCodes,
  KOKORO_DEFAULT_VOICES,
  KOKORO_VOICE_OPTIONS,
  READER_LANGUAGES,
  TtsVoicesUpdateSchema,
  isKokoroVoice,
  ttsVoiceSettingKey,
  type ReaderLanguage,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getDatabase } from '../db/connection.js';
import { getSetting, setSetting } from '../db/settings.js';
import { fail, ok, zodDetails } from '../utils/response.js';

export type TtsVoiceSource = 'settings' | 'env' | 'default';

export interface TtsVoiceInfo {
  /** Effective voice id for the language. */
  effective: string;
  /** Where the effective voice came from. */
  source: TtsVoiceSource;
  /** Voice explicitly chosen on the settings page, if any. */
  settingsValue: string | null;
  /** Env override, if set. */
  envValue: string | null;
  /** Selectable options for the language. */
  options: { id: string; gender: 'female' | 'male' }[];
}

function envVoice(env: Deps['env'], language: ReaderLanguage): string | null {
  switch (language) {
    case 'ja':
      return env.KOKORO_JA_VOICE ?? null;
    case 'zh':
      return env.KOKORO_ZH_VOICE ?? null;
    case 'en':
      return env.KOKORO_EN_VOICE ?? null;
  }
}

export function ttsVoiceInfo(env: Deps['env'], language: ReaderLanguage): TtsVoiceInfo {
  const db = getDatabase();
  const settingsValue = getSetting(ttsVoiceSettingKey(language), db);
  const envValue = envVoice(env, language);
  const effective = settingsValue ?? envValue ?? KOKORO_DEFAULT_VOICES[language];
  return {
    effective,
    source: settingsValue ? 'settings' : envValue ? 'env' : 'default',
    settingsValue,
    envValue,
    options: KOKORO_VOICE_OPTIONS[language],
  };
}

export function settingsRoutes(deps: Deps): Hono {
  const { env } = deps;
  const app = new Hono();

  // Current effective Kokoro voices per language, with selectable options.
  app.get('/tts-voices', (c) => {
    const voices = Object.fromEntries(
      READER_LANGUAGES.map((language) => [language, ttsVoiceInfo(env, language)]),
    );
    return ok(c, { voices });
  });

  // Save UI-chosen Kokoro voices. Each value must be a known voice id for
  // its language; partial updates are allowed.
  app.put('/tts-voices', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = TtsVoicesUpdateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid voice settings.', zodDetails(parsed.error));
    }
    for (const language of READER_LANGUAGES) {
      const voice = parsed.data[language];
      if (voice === undefined) continue;
      if (!isKokoroVoice(language, voice)) {
        return fail(
          c,
          400,
          ErrorCodes.INVALID_REQUEST,
          `Unknown Kokoro voice "${voice}" for language "${language}".`,
        );
      }
    }
    const db = getDatabase();
    for (const language of READER_LANGUAGES) {
      const voice = parsed.data[language];
      if (voice !== undefined) setSetting(ttsVoiceSettingKey(language), voice, db);
    }
    const voices = Object.fromEntries(
      READER_LANGUAGES.map((language) => [language, ttsVoiceInfo(env, language)]),
    );
    return ok(c, { voices });
  });

  return app;
}
