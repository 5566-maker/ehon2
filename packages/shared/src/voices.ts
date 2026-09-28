import type { ReaderLanguage } from './types.js';

/** One selectable Kokoro voice. Gender is derived from the voice id prefix (f/m). */
export interface KokoroVoiceOption {
  id: string;
  gender: 'female' | 'male';
}

function v(id: string): KokoroVoiceOption {
  return { id, gender: id.charAt(1) === 'm' ? 'male' : 'female' };
}

/**
 * Selectable Kokoro voices per reader language, validated against the
 * upstream Kokoro voice list. Shared by the server (validation, defaults)
 * and the web settings UI (dropdown options) so there is a single source
 * of truth.
 */
export const KOKORO_VOICE_OPTIONS: Record<ReaderLanguage, KokoroVoiceOption[]> = {
  ja: [v('jf_alpha'), v('jf_gongitsune'), v('jf_nezumi'), v('jf_tebukuro'), v('jm_kumo')],
  zh: [
    v('zf_xiaobei'),
    v('zf_xiaoni'),
    v('zf_xiaoxiao'),
    v('zf_xiaoyi'),
    v('zm_yunjian'),
    v('zm_yunxi'),
    v('zm_yunxia'),
    v('zm_yunyang'),
  ],
  en: [
    v('af_heart'),
    v('af_alloy'),
    v('af_aoede'),
    v('af_bella'),
    v('af_jessica'),
    v('af_kore'),
    v('af_nicole'),
    v('af_nova'),
    v('af_river'),
    v('af_sarah'),
    v('af_sky'),
    v('am_adam'),
    v('am_echo'),
    v('am_eric'),
    v('am_fenrir'),
    v('am_liam'),
    v('am_michael'),
    v('am_onyx'),
    v('am_puck'),
  ],
};

/** Built-in Kokoro voices, used when neither the settings page nor env overrides. */
export const KOKORO_DEFAULT_VOICES: Record<ReaderLanguage, string> = {
  ja: 'jf_alpha',
  zh: 'zf_xiaobei',
  en: 'af_heart',
} as const;

/** Whether a voice id is a known Kokoro voice for the language. */
export function isKokoroVoice(language: ReaderLanguage, voice: string): boolean {
  return KOKORO_VOICE_OPTIONS[language].some((o) => o.id === voice);
}

/** Settings-table key holding the UI-chosen Kokoro voice for a language. */
export function ttsVoiceSettingKey(language: ReaderLanguage): string {
  return `tts.voice.${language}`;
}

/** Where the effective TTS setting for a language came from. */
export type TtsSettingSource = 'settings' | 'env' | 'default';

/** Effective Kokoro voice per language, as reported by GET /api/settings/tts. */
export interface TtsVoiceInfo {
  /** Effective voice id for the language. */
  effective: string;
  /** Where the effective voice came from. */
  source: TtsSettingSource;
  /** Voice explicitly chosen on the settings page, if any. */
  settingsValue: string | null;
  /** Env override, if set. */
  envValue: string | null;
  /** Selectable options for the language. */
  options: KokoroVoiceOption[];
}

/** Selectable TTS speeds: 0.5 to 2.0 in 0.1 steps (16 options). */
export const TTS_SPEED_OPTIONS: number[] = Array.from({ length: 16 }, (_, i) => (5 + i) / 10);

/** Built-in TTS speed, used when neither the settings page nor env overrides. */
export const TTS_SPEED_DEFAULT = 1;

/** Settings-table key holding the UI-chosen TTS speed for a language. */
export function ttsSpeedSettingKey(language: ReaderLanguage): string {
  return `tts.speed.${language}`;
}

/**
 * Whether a value is a valid TTS speed: a finite number in 0.5–2.0 on a 0.1
 * step. Compares integer tenths to avoid floating-point error.
 */
export function isValidTtsSpeed(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const tenth = Math.round(value * 10);
  return tenth >= 5 && tenth <= 20 && Math.abs(value * 10 - tenth) < 1e-9;
}

/** Effective TTS speed per language, as reported by GET /api/settings/tts. */
export interface TtsSpeedInfo {
  /** Effective speed for the language. */
  effective: number;
  /** Where the effective speed came from. */
  source: TtsSettingSource;
  /** Speed explicitly chosen on the settings page, if any. */
  settingsValue: number | null;
  /** Env override (per-language or global), if set. */
  envValue: number | null;
  /** Selectable options for the language. */
  options: number[];
}
