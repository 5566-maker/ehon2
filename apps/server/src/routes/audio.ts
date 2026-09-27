import { Hono } from 'hono';
import { ErrorCodes } from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getAudio } from '../db/audio.js';
import { fail } from '../utils/response.js';
import { bufferToBody } from '../utils/media.js';

export function audioRoutes(deps: Deps): Hono {
  const { storage } = deps;
  const app = new Hono();

  // Authenticated audio delivery. Audio files are immutable per
  // (block, language, voice, speed, text_hash), so long private caching is safe.
  app.get('/:id', (c) => {
    const asset = getAudio(c.req.param('id'));
    if (!asset) return fail(c, 404, ErrorCodes.AUDIO_NOT_FOUND, 'Audio not found.');
    if (!storage.exists(asset.audioKey)) {
      return fail(c, 500, ErrorCodes.STORAGE_ERROR, 'Audio file is missing.');
    }
    const data = storage.read(asset.audioKey);
    return new Response(bufferToBody(data), {
      status: 200,
      headers: {
        'Content-Type': asset.contentType,
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Accept-Ranges': 'bytes',
      },
    });
  });

  return app;
}
