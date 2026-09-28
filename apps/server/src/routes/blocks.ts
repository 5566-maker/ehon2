import { Hono } from 'hono';
import {
  audioKey,
  AudioRequestSchema,
  ErrorCodes,
  ttsVoiceSettingKey,
  UpdateBlockSchema,
  type AudioRequestResult,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getDatabase } from '../db/connection.js';
import { deleteBlock, getBlock, getBlockBook, updateBlock } from '../db/blocks.js';
import { createAudio, deleteAudioAssetsByBlockId, findAudio, listAudioKeysByBlockId } from '../db/audio.js';
import { removeAudioFiles } from '../utils/audioFiles.js';
import { fail, ok, zodDetails } from '../utils/response.js';
import { AiError, selectTtsText, textHash } from '../openai/service.js';
import { getSetting } from '../db/settings.js';
import {
  audioCacheIdentity,
  resolveTtsSpeed,
  resolveTtsVoice,
  type TtsSynthesisResult,
} from '../tts/providers.js';

export function blocksRoutes(deps: Deps): Hono {
  const { env, storage, ai } = deps;
  const app = new Hono();

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = UpdateBlockSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid text block.', zodDetails(parsed.error));
    }
    const block = updateBlock(id, parsed.data, db);
    if (!block) return fail(c, 404, ErrorCodes.TEXT_BLOCK_NOT_FOUND, 'Text block not found.');
    // An edit invalidates cached audio (text_hash changes with the text);
    // drop the now-stale rows and files so they never play outdated speech.
    removeAudioFiles(storage, deleteAudioAssetsByBlockId(id, db));
    return ok(c, { block });
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const audioKeys = listAudioKeysByBlockId(id, db);
    const deleted = deleteBlock(id, db);
    if (!deleted) return fail(c, 404, ErrorCodes.TEXT_BLOCK_NOT_FOUND, 'Text block not found.');
    // DB rows cascade; remove the orphaned MP3 files too.
    removeAudioFiles(storage, audioKeys);
    return ok(c, { deleted: true });
  });

  app.post('/:id/audio', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const block = getBlock(id, db);
    if (!block) return fail(c, 404, ErrorCodes.TEXT_BLOCK_NOT_FOUND, 'Text block not found.');
    const ownership = getBlockBook(id, db);
    if (!ownership) return fail(c, 404, ErrorCodes.TEXT_BLOCK_NOT_FOUND, 'Text block not found.');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = AudioRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid audio request.', zodDetails(parsed.error));
    }
    const { language } = parsed.data;
    // Settings-page voice override wins over the env override and the default.
    const dbVoice = getSetting(ttsVoiceSettingKey(language), db);
    const ttsVoice = resolveTtsVoice(env, language, parsed.data.voice, dbVoice);
    const voice = ttsVoice.voice; // provider voice sent to the TTS request
    const cacheVoice = ttsVoice.cacheVoice; // namespaced cache identity (kokoro/* vs OpenAI)
    // Client-supplied speed wins; otherwise the per-language / global TTS_SPEED env default.
    const speed = Math.round((parsed.data.speed ?? resolveTtsSpeed(env, language)) * 100) / 100;

    const text = selectTtsText(block, language);
    if (!text || text.trim().length === 0) {
      return fail(c, 422, ErrorCodes.TTS_TEXT_UNAVAILABLE, 'No text is available for the selected language.');
    }
    if (text.length > env.AUDIO_MAX_CHARS) {
      return fail(
        c,
        422,
        ErrorCodes.TTS_TEXT_TOO_LONG,
        `Text is too long for TTS (max ${env.AUDIO_MAX_CHARS} characters).`,
      );
    }

    const hash = textHash(text);
    const cached = findAudio(id, language, cacheVoice, speed, hash, db);
    if (cached) {
      const result: AudioRequestResult = {
        audioUrl: `/api/audio/${cached.id}`,
        cached: true,
        language,
        voice,
        speed,
      };
      return ok(c, result);
    }

    let result: TtsSynthesisResult;
    try {
      result = await ai.synthesizeSpeech({ text, language, voice, speed });
    } catch (err) {
      const code = err instanceof AiError ? err.code : ErrorCodes.TTS_GENERATION_FAILED;
      console.error(`[tts] generation failed for block ${id}:`, err instanceof Error ? err.message : err);
      return fail(c, 502, code, 'Speech generation failed. Please try again.');
    }

    // Build the cache identity from the ACTUAL successful provider, not the
    // requested one: when Kokoro fails, OpenAI generates the audio, and it
    // must be cached under the OpenAI identity — never as kokoro/<voice>.
    const { cacheVoice: actualCacheVoice, keyVariant } = audioCacheIdentity(result);
    const key = audioKey(ownership.bookId, id, language, hash, keyVariant);
    try {
      storage.write(key, result.audio);
    } catch {
      return fail(c, 500, ErrorCodes.STORAGE_ERROR, 'Failed to store the generated audio.');
    }
    const asset = createAudio(
      { blockId: id, language, voice: actualCacheVoice, speed, audioKey: key, textHash: hash },
      db,
    );
    const finalResult: AudioRequestResult = {
      audioUrl: `/api/audio/${asset.id}`,
      cached: false,
      language,
      voice: result.voice,
      speed,
    };
    return ok(c, finalResult, 201);
  });

  return app;
}
