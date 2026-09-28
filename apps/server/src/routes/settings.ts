import { Hono } from 'hono';
import {
  ErrorCodes,
  KOKORO_DEFAULT_VOICES,
  KOKORO_VOICE_OPTIONS,
  READER_LANGUAGES,
  TTS_SPEED_DEFAULT,
  TTS_SPEED_OPTIONS,
  TtsSettingsUpdateSchema,
  isKokoroVoice,
  isValidTtsSpeed,
  ttsSpeedSettingKey,
  ttsVoiceSettingKey,
  type ReaderLanguage,
  type TtsSpeedInfo,
  type TtsVoiceInfo,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getDatabase } from '../db/connection.js';
import { getSetting, setSetting } from '../db/settings.js';
import { fail, ok, zodDetails } from '../utils/response.js';

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

/** Parse a stored speed setting; null when unset or (defensively) invalid. */
export function dbTtsSpeed(language: ReaderLanguage): number | null {
  const raw = getSetting(ttsSpeedSettingKey(language), getDatabase());
  if (raw === null) return null;
  const parsed = Number(raw);
  return isValidTtsSpeed(parsed) ? parsed : null;
}

export function ttsSpeedInfo(env: Deps['env'], language: ReaderLanguage): TtsSpeedInfo {
  const settingsValue = dbTtsSpeed(language);
  const perLanguage = { ja: env.TTS_SPEED_JA, zh: env.TTS_SPEED_ZH, en: env.TTS_SPEED_EN }[
    language
  ];
  const global = env.TTS_SPEED ?? null;
  const envValue = perLanguage ?? global;
  const effective = settingsValue ?? envValue ?? TTS_SPEED_DEFAULT;
  return {
    effective,
    source:
      settingsValue != null
        ? 'settings'
        : perLanguage != null || (global != null && global !== TTS_SPEED_DEFAULT)
          ? 'env'
          : 'default',
    settingsValue,
    envValue,
    options: TTS_SPEED_OPTIONS,
  };
}

export function settingsRoutes(deps: Deps): Hono {
  const { env } = deps;
  const app = new Hono();

  const current = () => ({
    voices: Object.fromEntries(
      READER_LANGUAGES.map((language) => [language, ttsVoiceInfo(env, language)]),
    ),
    speeds: Object.fromEntries(
      READER_LANGUAGES.map((language) => [language, ttsSpeedInfo(env, language)]),
    ),
  });

  // Current effective TTS voices + speeds per language, with selectable options.
  app.get('/tts', (c) => ok(c, current()));

  // Save UI-chosen TTS voices and/or speeds. Partial updates are allowed.
  // Voices must be known Kokoro voice ids; speeds must be 0.5–2.0 in 0.1 steps.
  app.put('/tts', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = TtsSettingsUpdateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid TTS settings.', zodDetails(parsed.error));
    }
    const { voices = {}, speeds = {} } = parsed.data;
    for (const language of READER_LANGUAGES) {
      const voice = voices[language];
      if (voice !== undefined && !isKokoroVoice(language, voice)) {
        return fail(
          c,
          400,
          ErrorCodes.INVALID_REQUEST,
          `Unknown Kokoro voice "${voice}" for language "${language}".`,
        );
      }
      const speed = speeds[language];
      if (speed !== undefined && !isValidTtsSpeed(speed)) {
        return fail(
          c,
          400,
          ErrorCodes.INVALID_REQUEST,
          `Invalid TTS speed "${speed}" for language "${language}": must be 0.5–2.0 in 0.1 steps.`,
        );
      }
    }
    const db = getDatabase();
    for (const language of READER_LANGUAGES) {
      const voice = voices[language];
      if (voice !== undefined) setSetting(ttsVoiceSettingKey(language), voice, db);
      const speed = speeds[language];
      if (speed !== undefined) {
        // Normalize to the exact tenth so the stored value round-trips cleanly.
        setSetting(ttsSpeedSettingKey(language), String(Math.round(speed * 10) / 10), db);
      }
    }
    return ok(c, current());
  });

  return app;
}
