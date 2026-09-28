import type { BBox } from '@ehon2/shared';

/** Error raised by the OCR layer (mirrors AiError's shape). */
export class OcrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Provider-neutral OCR types.
 *
 * Geometry is always normalized 0..1 coordinates (origin top-left),
 * relative to the exact image bytes the OCR provider consumed.
 */

/** One OCR-detected text fragment with exact provider geometry. */
export interface OcrFragment {
  /** Stable id assigned by the server, e.g. "ocr_001". */
  id: string;
  /** Recognized text for this fragment. */
  text: string;
  /** Normalized rectangular bbox (source of truth for rendering). */
  bbox: BBox;
  /** Optional original polygon vertices (normalized), when the provider gives them. */
  polygon?: { x: number; y: number }[];
  /** Provider confidence 0..1, when available. */
  confidence?: number | null;
  /** Provider hierarchy hints (from Vision fullTextAnnotation). */
  pageIndex?: number;
  blockIndex?: number;
  paragraphIndex?: number;
  wordIndex?: number;
}

/** Normalized result of one OCR pass over a page image. */
export interface OcrResult {
  provider: string;
  fullText: string;
  fragments: OcrFragment[];
  /** Image dimensions the normalized bboxes are relative to. */
  imageWidth: number;
  imageHeight: number;
}

export interface OcrRecognizeInput {
  imageBytes: Buffer;
  mimeType: string;
  /** Width/height of the image bytes (from the processed image record). */
  width: number;
  height: number;
}

export interface OcrProvider {
  readonly name: string;
  recognize(input: OcrRecognizeInput): Promise<OcrResult>;
}
