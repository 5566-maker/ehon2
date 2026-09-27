import sharp from 'sharp';
import { ACCEPTED_IMAGE_MIMES, EXT_BY_MIME, REJECTED_HEIC_MIMES } from '@ehon2/shared';

export interface ValidatedUpload {
  /** Raw bytes as uploaded. */
  bytes: Buffer;
  /** MIME type from the multipart part / sniffed. */
  mimeType: string;
  /** File extension derived from the MIME type (never from the filename). */
  extension: string;
}

export class UploadError extends Error {
  constructor(
    public readonly code: 'UPLOAD_TOO_LARGE' | 'UNSUPPORTED_IMAGE_TYPE',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validate an uploaded file: size limit, MIME allowlist.
 * HEIC/HEIF is rejected server-side — the web client converts it to JPEG
 * before upload (see apps/web/src/lib/heic.ts).
 */
export function validateUpload(
  file: File,
  bytes: Buffer,
  maxBytes: number,
): ValidatedUpload {
  if (bytes.byteLength > maxBytes) {
    throw new UploadError(
      'UPLOAD_TOO_LARGE',
      `Image is too large (max ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`,
    );
  }
  const mime = (file.type || '').toLowerCase();
  if ((REJECTED_HEIC_MIMES as readonly string[]).includes(mime)) {
    throw new UploadError(
      'UNSUPPORTED_IMAGE_TYPE',
      'HEIC photos must be converted to JPEG before upload. Please retry — the app converts them automatically.',
    );
  }
  if (!(ACCEPTED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    throw new UploadError(
      'UNSUPPORTED_IMAGE_TYPE',
      'Unsupported image type. Please upload JPEG, PNG, or WebP.',
    );
  }
  const extension = EXT_BY_MIME[mime] ?? 'jpg';
  return { bytes, mimeType: mime, extension };
}

export interface ProcessedImage {
  /** Optimized WebP bytes (EXIF-rotated, longest side <= maxDim). */
  webp: Buffer;
  width: number;
  height: number;
}

/**
 * Honor EXIF rotation, downscale so the longest side is at most `maxDim`,
 * and encode as WebP. Throws on undecodable input.
 */
export async function processImage(
  bytes: Buffer,
  maxDim: number,
  quality: number,
): Promise<ProcessedImage> {
  const pipeline = sharp(bytes, { failOn: 'none' }).rotate();
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to decode image dimensions');
  }
  const longest = Math.max(metadata.width, metadata.height);
  const resized =
    longest > maxDim
      ? pipeline.resize({
          width: metadata.width >= metadata.height ? maxDim : undefined,
          height: metadata.height > metadata.width ? maxDim : undefined,
          fit: 'inside',
          withoutEnlargement: true,
        })
      : pipeline;
  const webp = await resized.webp({ quality }).toBuffer();
  const outMeta = await sharp(webp).metadata();
  return {
    webp,
    width: outMeta.width ?? metadata.width,
    height: outMeta.height ?? metadata.height,
  };
}
