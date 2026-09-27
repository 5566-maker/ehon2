import type { Context } from 'hono';
import { ErrorCodes } from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { fail } from '../utils/response.js';

const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp3: 'audio/mpeg',
};

function contentTypeForKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Copy a Buffer into a plain Uint8Array (satisfies DOM BodyInit/BlobPart types). */
export function bufferToBody(data: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

/**
 * Serve a media file from DATA_DIR. `fallbackKey` is used when the primary
 * key is missing (e.g. processed image falls back to the original upload).
 */
export function serveMediaFile(
  c: Context,
  deps: Deps,
  key: string | null,
  fallbackKey: string | null = null,
  opts: { cacheControl?: string } = {},
): Response {
  const candidates = [key, fallbackKey].filter((k): k is string => !!k);
  for (const candidate of candidates) {
    if (!deps.storage.exists(candidate)) continue;
    const data = deps.storage.read(candidate);
    const type = contentTypeForKey(candidate);
    return new Response(bufferToBody(data), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(data.byteLength),
        'Cache-Control': opts.cacheControl ?? 'private, max-age=86400',
      },
    });
  }
  return fail(c, 500, ErrorCodes.STORAGE_ERROR, 'Media file is missing.');
}
