import type { BBox, TextRegion } from '@ehon2/shared';
import { ErrorCodes } from '@ehon2/shared';
import { OcrError } from './types.js';
import type { OcrFragment } from './types.js';

/**
 * Geometry normalization for OCR providers.
 *
 * Providers return absolute pixel vertices; the rest of the app works in
 * normalized 0..1 coordinates. OpenAI must never see or modify these —
 * they are the source of truth for click regions.
 */

export interface PixelVertex {
  x?: number | null;
  y?: number | null;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Convert absolute pixel vertices to a normalized bbox.
 * Returns null when the vertices are unusable (missing, degenerate,
 * zero-area after clamping).
 */
export function verticesToBbox(
  vertices: PixelVertex[] | undefined | null,
  imageWidth: number,
  imageHeight: number,
): BBox | null {
  if (!vertices || vertices.length === 0) return null;
  if (!isFiniteNum(imageWidth) || imageWidth <= 0) return null;
  if (!isFiniteNum(imageHeight) || imageHeight <= 0) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const v of vertices) {
    if (!v || !isFiniteNum(v.x) || !isFiniteNum(v.y)) return null;
    xs.push(v.x);
    ys.push(v.y);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX <= minX || maxY <= minY) return null;

  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const x = clamp01(minX / imageWidth);
  const y = clamp01(minY / imageHeight);
  let width = clamp01(maxX / imageWidth) - x;
  let height = clamp01(maxY / imageHeight) - y;
  if (x + width > 1) width = 1 - x;
  if (y + height > 1) height = 1 - y;
  // Reject slivers that can never be tapped or seen.
  if (width * height < 1e-8) return null;
  return { x, y, width, height };
}

/** Normalize an already-0..1 bbox (clamp + validate). Returns null if unusable. */
export function sanitizeNormalizedBbox(raw: BBox): BBox | null {
  const out = verticesToBbox(
    [
      { x: raw.x, y: raw.y },
      { x: raw.x + raw.width, y: raw.y + raw.height },
    ],
    1,
    1,
  );
  return out;
}

/** Union bbox covering all given bboxes (for legacy single-bbox compatibility). */
export function unionBbox(bboxes: BBox[]): BBox | null {
  const valid = bboxes.filter(
    (b) => isFiniteNum(b.x) && isFiniteNum(b.y) && isFiniteNum(b.width) && isFiniteNum(b.height),
  );
  if (valid.length === 0) return null;
  const left = Math.min(...valid.map((b) => b.x));
  const top = Math.min(...valid.map((b) => b.y));
  const right = Math.max(...valid.map((b) => b.x + b.width));
  const bottom = Math.max(...valid.map((b) => b.y + b.height));
  return sanitizeNormalizedBbox({
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  });
}

/**
 * Map a validated enrichment block's ocr_ids to clickable regions.
 * Throws INVALID_OCR_REFERENCE if an id is not in the cached fragments.
 */
export function regionsForOcrIds(
  ocrIds: string[],
  fragmentsById: Map<string, OcrFragment>,
): TextRegion[] {
  return ocrIds.map((ocrId) => {
    const frag = fragmentsById.get(ocrId);
    if (!frag) {
      throw new OcrError(ErrorCodes.INVALID_OCR_REFERENCE, `Unknown OCR fragment id referenced: ${ocrId}`);
    }
    return {
      ocrId,
      x: frag.bbox.x,
      y: frag.bbox.y,
      width: frag.bbox.width,
      height: frag.bbox.height,
    };
  });
}
