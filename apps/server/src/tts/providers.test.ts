import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCodes } from '@ehon2/shared';
import {
  KokoroTtsProvider,
  OpenAiTtsProvider,
  TtsError,
  audioCacheIdentity,
  kokoroVoiceFor,
  resolveTtsSpeed,
  resolveTtsVoice,
  sanitizeVoiceForKey,
} from './providers.js';
import { AiError, AiService } from '../openai/service.js';
import type { AppEnv } from '../env.js';

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]); // "ID3..."
const OPENAI_MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x01]);

function okAudio(body: Buffer = MP3, contentType = 'audio/mpeg'): Response {
  return new Response(body as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType } });
}

function kokoroProvider(
  fetchFn: (url: string, init: { body?: unknown; signal: AbortSignal }) => Promise<Response>,
  timeoutMs = 30_000,
) {
  return new KokoroTtsProvider({
    baseUrl: 'http://kokoro:8880/',
    model: 'kokoro',
    timeoutMs,
    fetchFn: fetchFn as typeof fetch,
  });
}

describe('KokoroTtsProvider', () => {
  it('posts an OpenAI-compatible request and returns MP3 bytes', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const p = kokoroProvider(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return okAudio();
    });
    const out = await p.synthesize({ text: 'こんにちは', language: 'ja', voice: 'jf_alpha', speed: 1 });
    assert.deepEqual(out, MP3);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, 'http://kokoro:8880/v1/audio/speech');
    assert.deepEqual(seen[0]!.body, {
      model: 'kokoro',
      input: 'こんにちは',
      voice: 'jf_alpha',
      response_format: 'mp3',
      speed: 1,
    });
  });

  it('marks connection failures as retryable', async () => {
    const p = kokoroProvider(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) =>
        err instanceof TtsError &&
        err.retryable === true &&
        err.code === ErrorCodes.TTS_GENERATION_FAILED,
    );
  });

  it('marks HTTP 500 as retryable', async () => {
    const p = kokoroProvider(async () => new Response('boom', { status: 500 }));
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) => err instanceof TtsError && err.retryable === true,
    );
  });

  it('rejects an HTML error page returned as HTTP 200', async () => {
    const p = kokoroProvider(async () =>
      okAudio(Buffer.from('<html><body>error</body></html>'), 'text/html'),
    );
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) => err instanceof TtsError && err.retryable === true,
    );
  });

  it('rejects a JSON error body returned as HTTP 200', async () => {
    const p = kokoroProvider(async () =>
      okAudio(Buffer.from('{"detail":"nope"}'), 'application/json'),
    );
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) => err instanceof TtsError && err.retryable === true,
    );
  });

  it('rejects a JSON-looking body even with an audio content-type', async () => {
    const p = kokoroProvider(async () => okAudio(Buffer.from('{"detail":"nope"}'), 'audio/mpeg'));
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) => err instanceof TtsError && err.retryable === true,
    );
  });

  it('rejects empty audio as retryable', async () => {
    const p = kokoroProvider(async () => okAudio(Buffer.alloc(0)));
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) => err instanceof TtsError && err.retryable === true,
    );
  });

  it('aborts on timeout and marks it retryable', async () => {
    const p = kokoroProvider(
      (url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
      25,
    );
    await assert.rejects(
      () => p.synthesize({ text: 'hi', language: 'en', voice: 'af_heart', speed: 1 }),
      (err: unknown) => err instanceof TtsError && err.retryable === true,
    );
  });
});

describe('OpenAiTtsProvider', () => {
  it('calls the OpenAI speech API and returns MP3 bytes', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      audio: {
        speech: {
          create: async (args: Record<string, unknown>) => {
            seen.push(args);
            return { arrayBuffer: async () => OPENAI_MP3 };
          },
        },
      },
    } as never;
    const p = new OpenAiTtsProvider(client, 'gpt-4o-mini-tts');
    const out = await p.synthesize({ text: 'hello', language: 'en', voice: 'alloy', speed: 1 });
    assert.deepEqual(out, OPENAI_MP3);
    assert.deepEqual(seen[0], {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'hello',
      speed: 1,
      response_format: 'mp3',
    });
  });

  it('marks OpenAI failures as non-retryable (last in chain)', async () => {
    const client = {
      audio: { speech: { create: async () => { throw new Error('429'); } } },
    } as never;
    const p = new OpenAiTtsProvider(client, 'gpt-4o-mini-tts');
    await assert.rejects(
      () => p.synthesize({ text: 'hello', language: 'en', voice: 'alloy', speed: 1 }),
      (err: unknown) =>
        err instanceof TtsError &&
        err.retryable === false &&
        err.code === ErrorCodes.TTS_GENERATION_FAILED,
    );
  });
});

describe('voice resolution', () => {
  const kokoroEnv = {
    TTS_PROVIDER: 'kokoro',
    KOKORO_BASE_URL: 'http://kokoro:8880',
    KOKORO_TTS_MODEL: 'kokoro',
    DEFAULT_JA_VOICE: 'alloy',
    DEFAULT_ZH_VOICE: 'echo',
    DEFAULT_EN_VOICE: 'verse',
  } as unknown as AppEnv;

  it('resolves validated per-language Kokoro defaults', () => {
    assert.deepEqual(resolveTtsVoice(kokoroEnv, 'ja', 'default'), {
      provider: 'kokoro',
      voice: 'jf_alpha',
      cacheVoice: 'kokoro/jf_alpha',
    });
    assert.equal(resolveTtsVoice(kokoroEnv, 'zh', 'default').voice, 'zf_xiaobei');
    assert.equal(resolveTtsVoice(kokoroEnv, 'en', 'default').voice, 'af_heart');
  });

  it('honors KOKORO_*_VOICE overrides', () => {
    const env = { ...kokoroEnv, KOKORO_JA_VOICE: 'jm_kumo' } as AppEnv;
    assert.equal(kokoroVoiceFor(env, 'ja'), 'jm_kumo');
    assert.equal(resolveTtsVoice(env, 'ja', 'default').cacheVoice, 'kokoro/jm_kumo');
  });

  it('passes explicit voices through to Kokoro', () => {
    const r = resolveTtsVoice(kokoroEnv, 'ja', 'jf_nezumi');
    assert.equal(r.voice, 'jf_nezumi');
    assert.equal(r.cacheVoice, 'kokoro/jf_nezumi');
  });

  it('resolveTtsSpeed uses the global TTS_SPEED by default', () => {
    const env = { TTS_SPEED: 1 } as AppEnv;
    assert.equal(resolveTtsSpeed(env, 'ja'), 1);
    assert.equal(resolveTtsSpeed(env, 'zh'), 1);
    assert.equal(resolveTtsSpeed(env, 'en'), 1);
  });

  it('resolveTtsSpeed prefers per-language overrides', () => {
    const env = { TTS_SPEED: 1, TTS_SPEED_JA: 1.2, TTS_SPEED_ZH: 1.25 } as AppEnv;
    assert.equal(resolveTtsSpeed(env, 'ja'), 1.2);
    assert.equal(resolveTtsSpeed(env, 'zh'), 1.25);
    assert.equal(resolveTtsSpeed(env, 'en'), 1);
  });

  it('keeps legacy cache identity for the OpenAI provider', () => {
    const env = { ...kokoroEnv, TTS_PROVIDER: 'openai' } as AppEnv;
    assert.deepEqual(resolveTtsVoice(env, 'ja', 'default'), {
      provider: 'openai',
      voice: 'alloy',
      cacheVoice: 'alloy',
    });
  });

  it('sanitizes voices for storage keys', () => {
    assert.equal(sanitizeVoiceForKey('jf_alpha'), 'jf-alpha');
    assert.equal(sanitizeVoiceForKey('kokoro/jf_alpha'), 'kokoro-jf-alpha');
  });
});

describe('AiService.synthesizeSpeech fallback', () => {
  function service(opts: {
    ttsProvider?: string;
    kokoroBehavior: 'ok' | 'fail';
    openaiBehavior: 'ok' | 'fail';
  }) {
    const fetchCalls: string[] = [];
    const openaiCalls: Record<string, unknown>[] = [];
    const svc = new AiService(
      {
        OPENAI_API_KEY: 'k',
        TTS_PROVIDER: opts.ttsProvider ?? 'kokoro',
        OPENAI_TTS_MODEL: 'gpt-4o-mini-tts',
        KOKORO_BASE_URL: 'http://kokoro:8880',
        KOKORO_TTS_MODEL: 'kokoro',
        DEFAULT_JA_VOICE: 'alloy',
        DEFAULT_ZH_VOICE: 'echo',
        DEFAULT_EN_VOICE: 'verse',
      } as never,
      {
        client: {
          audio: {
            speech: {
              create: async (args: Record<string, unknown>) => {
                openaiCalls.push(args);
                if (opts.openaiBehavior === 'fail') throw new Error('openai down');
                return { arrayBuffer: async () => OPENAI_MP3 };
              },
            },
          },
        } as never,
        kokoroFetch: (async (url: string) => {
          fetchCalls.push(url);
          if (opts.kokoroBehavior === 'fail') throw new Error('conn refused');
          return okAudio();
        }) as typeof fetch,
      },
    );
    return { svc, fetchCalls, openaiCalls };
  }

  const input = { text: 'こんにちは', language: 'ja' as const, voice: 'jf_alpha', speed: 1 };

  it('uses Kokoro when it succeeds (no OpenAI call)', async () => {
    const { svc, fetchCalls, openaiCalls } = service({ kokoroBehavior: 'ok', openaiBehavior: 'ok' });
    const out = await svc.synthesizeSpeech(input);
    assert.deepEqual(out.audio, MP3);
    assert.equal(out.provider, 'kokoro');
    assert.equal(out.voice, 'jf_alpha');
    assert.equal(out.model, 'kokoro');
    assert.equal(fetchCalls.length, 1);
    assert.equal(openaiCalls.length, 0);
  });

  it('falls back once to OpenAI when Kokoro fails', async () => {
    const { svc, fetchCalls, openaiCalls } = service({ kokoroBehavior: 'fail', openaiBehavior: 'ok' });
    const out = await svc.synthesizeSpeech(input);
    assert.deepEqual(out.audio, OPENAI_MP3);
    assert.equal(out.provider, 'openai');
    assert.equal(out.voice, 'alloy');
    assert.equal(out.model, 'gpt-4o-mini-tts');
    assert.equal(fetchCalls.length, 1);
    assert.equal(openaiCalls.length, 1);
    // The fallback must use an OpenAI voice, never the Kokoro voice id.
    assert.equal(openaiCalls[0]!['voice'], 'alloy');
    assert.equal(openaiCalls[0]!['model'], 'gpt-4o-mini-tts');
  });

  it('propagates the error when both providers fail (no infinite loop)', async () => {
    const { svc, fetchCalls, openaiCalls } = service({ kokoroBehavior: 'fail', openaiBehavior: 'fail' });
    await assert.rejects(
      () => svc.synthesizeSpeech(input),
      (err: unknown) => err instanceof AiError && err.code === ErrorCodes.TTS_GENERATION_FAILED,
    );
    assert.equal(fetchCalls.length, 1);
    assert.equal(openaiCalls.length, 1);
  });

  it('does not fall back for empty text (local validation error)', async () => {
    const { svc, fetchCalls, openaiCalls } = service({ kokoroBehavior: 'fail', openaiBehavior: 'ok' });
    await assert.rejects(
      () => svc.synthesizeSpeech({ ...input, text: '   ' }),
      (err: unknown) => err instanceof AiError && err.code === ErrorCodes.TTS_TEXT_UNAVAILABLE,
    );
    assert.equal(fetchCalls.length, 0);
    assert.equal(openaiCalls.length, 0);
  });

  it('TTS_PROVIDER=openai uses OpenAI directly without touching Kokoro', async () => {
    const { svc, fetchCalls, openaiCalls } = service({
      ttsProvider: 'openai',
      kokoroBehavior: 'fail',
      openaiBehavior: 'ok',
    });
    const out = await svc.synthesizeSpeech({ ...input, voice: 'alloy' });
    assert.deepEqual(out.audio, OPENAI_MP3);
    assert.equal(out.provider, 'openai');
    assert.equal(out.voice, 'alloy');
    assert.equal(out.model, 'gpt-4o-mini-tts');
    assert.equal(fetchCalls.length, 0);
    assert.equal(openaiCalls.length, 1);
    assert.equal(openaiCalls[0]!['voice'], 'alloy');
  });
});

describe('audioCacheIdentity', () => {
  it('namespaces Kokoro audio under kokoro/<voice>', () => {
    assert.deepEqual(audioCacheIdentity({ provider: 'kokoro', voice: 'jf_alpha' }), {
      cacheVoice: 'kokoro/jf_alpha',
      keyVariant: 'kokoro-jf-alpha',
    });
  });

  it('keeps the legacy bare-voice identity for OpenAI audio', () => {
    assert.deepEqual(audioCacheIdentity({ provider: 'openai', voice: 'alloy' }), {
      cacheVoice: 'alloy',
      keyVariant: undefined,
    });
  });
});
