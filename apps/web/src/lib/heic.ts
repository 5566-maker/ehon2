/**
 * HEIC/HEIF handling. The server rejects HEIC (sharp has no HEIC decoder by
 * default), so the client converts to JPEG before upload.
 *
 * Two decode paths:
 * 1. Native (fast): iPhone Safari decodes HEIC in an <img>, so drawing it to
 *    a canvas and exporting JPEG works on the devices that produce HEIC.
 * 2. WASM fallback (lazy-loaded): desktop browsers cannot decode HEIC, so we
 *    fall back to heic2any (libheif compiled to WebAssembly). The ~1.3 MB
 *    decoder chunk is only downloaded when a desktop browser hits a HEIC file.
 */

const HEIC_TYPES = ['image/heic', 'image/heif'];
const HEIC_EXTS = ['.heic', '.heif'];

export function isHeicFile(file: File): boolean {
  if (HEIC_TYPES.includes(file.type.toLowerCase())) return true;
  const name = file.name.toLowerCase();
  return HEIC_EXTS.some((ext) => name.endsWith(ext));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
}

function toJpegName(name: string): string {
  const renamed = name.replace(/\.(heic|heif)$/i, '.jpg');
  return renamed.endsWith('.jpg') ? renamed : `${renamed}.jpg`;
}

/**
 * Native decode via <img> + canvas. Only works where the browser decodes
 * HEIC itself (iPhone Safari).
 */
async function convertViaCanvas(file: File, quality: number): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) throw new Error('conversion produced no data');
    return new File([blob], toJpegName(file.name), { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Extract a readable message from anything a decoder might reject with. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    // heic2any rejects with plain { code, message } objects.
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

type Heic2AnyFn = (opts: {
  blob: Blob;
  toType: string;
  quality?: number;
}) => Promise<Blob | Blob[]>;

/** WASM decode via heic2any. Works in any modern desktop browser. */
async function convertViaWasm(file: File, quality: number): Promise<File> {
  let heic2any: Heic2AnyFn;
  try {
    ({ default: heic2any } = await import('heic2any'));
  } catch (err) {
    throw new Error(`HEIC decoder failed to load: ${describeError(err)}`);
  }
  if (typeof heic2any !== 'function') {
    throw new Error('HEIC decoder failed to load: unexpected module shape');
  }
  let result: Blob | Blob[];
  try {
    result = await heic2any({ blob: file, toType: 'image/jpeg', quality });
  } catch (err) {
    throw new Error(`HEIC decode failed: ${describeError(err)}`);
  }
  const blob = Array.isArray(result) ? result[0] : result;
  if (!blob) throw new Error('HEIC decode produced no data');
  return new File([blob], toJpegName(file.name), { type: 'image/jpeg' });
}

/** Convert a HEIC/HEIF file to JPEG. Throws when the browser cannot decode it. */
export async function convertHeicToJpeg(file: File, quality = 0.92): Promise<File> {
  try {
    return await convertViaCanvas(file, quality);
  } catch {
    // Desktop browsers can't decode HEIC natively — fall back to WASM.
  }
  return convertViaWasm(file, quality);
}

/**
 * Ensure an uploadable image: converts HEIC to JPEG when needed,
 * passes everything else through unchanged.
 */
export async function prepareUploadFile(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;
  try {
    return await convertHeicToJpeg(file);
  } catch (err) {
    const detail = describeError(err);
    // Keep the technical reason visible so a failed conversion can be diagnosed
    // from the message alone.
    console.error('[heic] conversion failed:', detail);
    throw new Error(
      `无法读取这张 HEIC 照片${detail ? `（${detail}）` : ''}，请在相册中导出为 JPEG 后再上传。`,
    );
  }
}
