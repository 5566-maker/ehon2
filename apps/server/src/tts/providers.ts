import OpenAI from 'openai';
import { ErrorCodes, KOKORO_DEFAULT_VOICES, type ReaderLanguage } from '@ehon2/shared';
import type { AppEnv } from '../env.js';
import { AiError } from '../openai/errors.js';

/* ------------------------------------------------------------------ */
/* TTS provider abstraction                                            */
/*                                                                     */
/* Kokoro (self-hosted FastAPI, OpenAI-compatible /v1/audio/speech)    */
/* is the primary provider; OpenAI TTS stays as a one-shot fallback.  */
/* Route handlers use resolveTtsVoice + AiService.synthesizeSpeech and  */
/* never build provider-specific requests themselves.                  */
/* ------------------------------------------------------------------ */

export type TtsProviderName = 'kokoro' | 'openai';

export interface TtsSynthesizeInput {
  text: string;
  language: ReaderLanguage;
  voice: string;
  speed: number;
}

export interface TtsProvider {
  readonly name: TtsProviderName;
  synthesize(input: TtsSynthesizeInput): Promise<Buffer>;
}

/**
 * Result of a TTS synthesis: the audio plus which provider actually
 * generated it. Callers must build cache identity / storage keys from
 * THESE values, never from the requested provider — Kokoro may fail and
 * OpenAI may generate the audio instead.
 */
export interface TtsSynthesisResult {
  audio: Buffer;
  provider: TtsProviderName;
  /** Voice id actually sent to the successful provider. */
  voice: string;
  /** Model actually used (KOKORO_TTS_MODEL or OPENAI_TTS_MODEL). */
  model: string;
}

/**
 * Cache identity + storage key variant for a synthesis result.
 * Kokoro audio is namespaced (`kokoro/<voice>`) so Kokoro and OpenAI
 * generations never share a cache row; OpenAI keeps its legacy identity
 * (bare voice id) so existing cache rows stay valid.
 */
export function audioCacheIdentity(result: Pick<TtsSynthesisResult, 'provider' | 'voice'>): {
  cacheVoice: string;
  keyVariant: string | undefined;
} {
  if (result.provider === 'kokoro') {
    return {
      cacheVoice: `kokoro/${result.voice}`,
      keyVariant: `kokoro-${sanitizeVoiceForKey(result.voice)}`,
    };
  }
  return { cacheVoice: result.voice, keyVariant: undefined };
}

/**
 * Error raised by a TTS provider.
 * `retryable` marks failures worth one attempt with the next provider in
 * the chain (connection/timeout/5xx/invalid audio). Local problems that a
 * different provider cannot fix must use `retryable: false`.
 */
export class TtsError extends AiError {
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean, cause?: unknown) {
    super(code, message, cause);
    this.retryable = retryable;
  }
}

/** Built-in Kokoro voices, validated against the Kokoro voice list. (shared) */
export { KOKORO_DEFAULT_VOICES } from '@ehon2/shared';

/**
 * Resolve the Kokoro voice for a language.
 * Priority: settings-page DB override > env override > built-in default.
 */
export function kokoroVoiceFor(
  env: AppEnv,
  language: ReaderLanguage,
  dbVoice?: string | null,
): string {
  if (dbVoice) return dbVoice;
  switch (language) {
    case 'ja':
      return env.KOKORO_JA_VOICE ?? KOKORO_DEFAULT_VOICES.ja;
    case 'zh':
      return env.KOKORO_ZH_VOICE ?? KOKORO_DEFAULT_VOICES.zh;
    case 'en':
      return env.KOKORO_EN_VOICE ?? KOKORO_DEFAULT_VOICES.en;
  }
}

/** Resolve "default" to the configured OpenAI voice for the language. */
export function resolveVoice(env: AppEnv, language: ReaderLanguage, voice: string): string {
  if (voice !== 'default') return voice;
  switch (language) {
    case 'ja':
      return env.DEFAULT_JA_VOICE;
    case 'zh':
      return env.DEFAULT_ZH_VOICE;
    case 'en':
      return env.DEFAULT_EN_VOICE;
  }
}

export interface ResolvedTtsVoice {
  /** Which provider will synthesize. */
  provider: TtsProviderName;
  /** Voice id sent to that provider. */
  voice: string;
  /**
   * Voice identity used for the audio cache. Kokoro entries are namespaced
   * (`kokoro/jf_alpha`) so Kokoro and OpenAI audio never share a cached
   * row; OpenAI keeps its legacy identity so old cache rows stay valid.
   */
  cacheVoice: string;
}

/**
 * Resolve the requested voice for the configured TTS provider.
 * An explicit non-default voice in the request wins; otherwise the
 * settings-page DB override wins over the env override and the default.
 */
export function resolveTtsVoice(
  env: AppEnv,
  language: ReaderLanguage,
  requested: string,
  dbVoice?: string | null,
): ResolvedTtsVoice {
  if (env.TTS_PROVIDER === 'openai') {
    const voice = resolveVoice(env, language, requested);
    return { provider: 'openai', voice, cacheVoice: voice };
  }
  const voice = requested !== 'default' ? requested : kokoroVoiceFor(env, language, dbVoice);
  return { provider: 'kokoro', voice, cacheVoice: `kokoro/${voice}` };
}

/**
 * Resolve the default TTS speed for a language.
 * Priority: settings-page DB override > per-language env (TTS_SPEED_JA/ZH/EN)
 * > global TTS_SPEED. A client-supplied request speed still wins over all of
 * these (see blocks route).
 */
export function resolveTtsSpeed(
  env: AppEnv,
  language: ReaderLanguage,
  dbSpeed?: number | null,
): number {
  if (dbSpeed != null) return dbSpeed;
  const perLanguage = { ja: env.TTS_SPEED_JA, zh: env.TTS_SPEED_ZH, en: env.TTS_SPEED_EN }[
    language
  ];
  return perLanguage ?? env.TTS_SPEED;
}

/** Make a voice id safe for embedding in a storage key segment. */
export function sanitizeVoiceForKey(voice: string): string {
  return voice
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const KOKORO_TIMEOUT_MS = 30_000;

export class KokoroTtsProvider implements TtsProvider {
  readonly name: TtsProviderName = 'kokoro';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? KOKORO_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async synthesize(input: TtsSynthesizeInput): Promise<Buffer> {
    const url = `${this.baseUrl}/v1/audio/speech`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: input.text,
          voice: input.voice,
          response_format: 'mp3',
          speed: input.speed,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new TtsError(
        ErrorCodes.TTS_GENERATION_FAILED,
        `Kokoro TTS request failed: ${shortErr(err)}`,
        true,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TtsError(
        ErrorCodes.TTS_GENERATION_FAILED,
        `Kokoro TTS returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        true,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    const audio = Buffer.from(await res.arrayBuffer());
    assertAudioPayload(audio, contentType);
    return audio;
  }
}

/**
 * Validate a Kokoro response body: must be non-empty audio, not an HTML or
 * JSON error page that slipped through with HTTP 200.
 */
function assertAudioPayload(audio: Buffer, contentType: string): void {
  if (audio.length === 0) {
    throw new TtsError(ErrorCodes.TTS_GENERATION_FAILED, 'Kokoro TTS returned empty audio', true);
  }
  const ct = (contentType.toLowerCase().split(';')[0] ?? '').trim();
  if (ct && ct !== 'application/octet-stream' && !ct.startsWith('audio/')) {
    throw new TtsError(
      ErrorCodes.TTS_GENERATION_FAILED,
      `Kokoro TTS returned non-audio content-type: ${contentType}`,
      true,
    );
  }
  const head = audio.subarray(0, Math.min(audio.length, 64)).toString('latin1').trimStart();
  if (head.startsWith('<') || head.startsWith('{') || head.startsWith('[')) {
    throw new TtsError(
      ErrorCodes.TTS_GENERATION_FAILED,
      'Kokoro TTS returned a non-audio payload (possible error page)',
      true,
    );
  }
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly name: TtsProviderName = 'openai';
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async synthesize(input: TtsSynthesizeInput): Promise<Buffer> {
    let response;
    try {
      response = await this.client.audio.speech.create({
        model: this.model,
        voice: input.voice as 'alloy',
        input: input.text,
        speed: input.speed,
        response_format: 'mp3',
      });
    } catch (err) {
      throw new TtsError(
        ErrorCodes.TTS_GENERATION_FAILED,
        `OpenAI TTS failed: ${shortErr(err)}`,
        false,
        err,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

/** One-line error summary for logs — no keys, no request bodies. */
function shortErr(err: unknown, max = 160): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}
