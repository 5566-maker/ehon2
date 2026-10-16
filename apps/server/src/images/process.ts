import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ACCEPTED_IMAGE_MIMES, EXT_BY_MIME } from '@ehon2/shared';

const execFileAsync = promisify(execFile);

const HEIC_MIMES = ['image/heic', 'image/heif'];

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
 * HEIC/HEIF is accepted — it is converted to JPEG before sharp processing
 * (see convertHeicToJpeg).
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
  if (!(ACCEPTED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    throw new UploadError(
      'UNSUPPORTED_IMAGE_TYPE',
      'Unsupported image type. Please upload JPEG, PNG, WebP, or HEIC.',
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
 * Convert HEIC/HEIF bytes to JPEG via the system `heif-convert` binary
 * (libheif + libde265, installed in the Docker image). sharp's bundled
 * libheif can parse HEIC metadata but cannot decode HEVC pixels, so HEIC
 * must go through this step first. Picks the first image for multi-image
 * HEIC files. Throws when conversion fails (missing binary, corrupt file).
 */
export async function convertHeicToJpeg(bytes: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'ehon2-heic-'));
  try {
    const input = join(dir, 'input.heic');
    const output = join(dir, 'out.jpg');
    await writeFile(input, bytes);
    await execFileAsync('heif-convert', ['-q', '90', input, output], {
      timeout: 30_000,
    });
    // Single-image HEIC -> out.jpg; multi-image -> out-1.jpg, out-2.jpg, ...
    const files = (await readdir(dir)).filter((f) => f.startsWith('out') && f.endsWith('.jpg'));
    const pick = files.includes('out.jpg') ? 'out.jpg' : files.sort()[0];
    if (!pick) throw new Error('heif-convert produced no output');
    return await readFile(join(dir, pick));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Honor EXIF rotation, downscale so the longest side is at most `maxDim`,
 * and encode as WebP. Throws on undecodable input.
 * Pass the validated upload MIME type so HEIC/HEIF inputs are converted
 * with heif-convert before sharp sees them.
 */
export async function processImage(
  bytes: Buffer,
  maxDim: number,
  quality: number,
  mime?: string,
): Promise<ProcessedImage> {
  const decodable =
    mime && HEIC_MIMES.includes(mime.toLowerCase()) ? await convertHeicToJpeg(bytes) : bytes;
  const pipeline = sharp(decodable, { failOn: 'none' }).rotate();
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
