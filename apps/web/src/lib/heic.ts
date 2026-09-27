/**
 * HEIC/HEIF handling. The server rejects HEIC (sharp has no HEIC decoder by
 * default), so the client converts to JPEG before upload.
 *
 * iPhone Safari can decode HEIC natively in an <img>, so drawing it to a
 * canvas and exporting JPEG works on the devices that produce HEIC photos.
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

/** Convert a HEIC/HEIF file to JPEG. Throws when the browser cannot decode it. */
export async function convertHeicToJpeg(file: File, quality = 0.92): Promise<File> {
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
    const name = file.name.replace(/\.(heic|heif)$/i, '.jpg');
    return new File([blob], name.endsWith('.jpg') ? name : `${name}.jpg`, {
      type: 'image/jpeg',
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Ensure an uploadable image: converts HEIC to JPEG when needed,
 * passes everything else through unchanged.
 */
export async function prepareUploadFile(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;
  try {
    return await convertHeicToJpeg(file);
  } catch {
    throw new Error('无法读取这张 HEIC 照片，请在相册中导出为 JPEG 后再上传。');
  }
}
