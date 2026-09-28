import { ErrorCodes } from '@ehon2/shared';
import { OcrError } from './provider.js';
import { verticesToBbox, type PixelVertex } from './normalize.js';
import type { OcrFragment, OcrProvider, OcrRecognizeInput, OcrResult } from './types.js';

/**
 * Google Cloud Vision OCR provider (server-side only).
 *
 * Uses DOCUMENT_TEXT_DETECTION over HTTPS with an API key. No extra npm
 * dependencies — plain fetch. The API key never leaves the server.
 */

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

interface VisionSymbol {
  text?: string;
  confidence?: number;
}
interface VisionWord {
  symbols?: VisionSymbol[];
  confidence?: number;
  boundingBox?: { vertices?: PixelVertex[] };
}
interface VisionParagraph {
  words?: VisionWord[];
  confidence?: number;
  boundingBox?: { vertices?: PixelVertex[] };
}
interface VisionBlock {
  paragraphs?: VisionParagraph[];
  boundingBox?: { vertices?: PixelVertex[] };
}
interface VisionPage {
  blocks?: VisionBlock[];
  width?: number;
  height?: number;
}
interface VisionFullTextAnnotation {
  text?: string;
  pages?: VisionPage[];
}
interface VisionResponse {
  responses?: {
    fullTextAnnotation?: VisionFullTextAnnotation;
    error?: { code?: number; message?: string; status?: string };
  }[];
  error?: { code?: number; message?: string; status?: string };
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function wordText(word: VisionWord): string {
  return (word.symbols ?? []).map((s) => s.text ?? '').join('');
}

function paragraphText(paragraph: VisionParagraph): string {
  const words = (paragraph.words ?? []).map(wordText).filter((w) => w.length > 0);
  if (words.length === 0) return '';
  const joined = words.join('');
  // Insert spaces only for non-CJK text (English words need them).
  return CJK_RE.test(joined) ? joined : words.join(' ');
}

/** Extract line-like fragments from fullTextAnnotation paragraphs. */
export function extractFragments(
  annotation: VisionFullTextAnnotation | undefined,
  imageWidth: number,
  imageHeight: number,
): { fragments: Omit<OcrFragment, 'id'>[]; fullText: string } {
  // TODO(ocr-lines): group words into visual lines before emitting fragments.
  // Vision returns paragraph-level bboxes here, but for picture books a
  // "paragraph" is often the whole page, so fragments come out too coarse and
  // misaligned with the actual text lines. The fix is to cluster
  // paragraph.words by their vertical overlap (y-center within ~half a word
  // height) into line groups, then emit one fragment per line with the union
  // bbox of its words. Deliberately not implemented in this pass.
  const fullText = annotation?.text ?? '';
  const fragments: Omit<OcrFragment, 'id'>[] = [];
  const pages = annotation?.pages ?? [];
  pages.forEach((page, pageIndex) => {
    (page.blocks ?? []).forEach((block, blockIndex) => {
      (block.paragraphs ?? []).forEach((paragraph, paragraphIndex) => {
        const text = paragraphText(paragraph).trim();
        if (!text) return;
        const bbox = verticesToBbox(
          paragraph.boundingBox?.vertices,
          imageWidth,
          imageHeight,
        );
        if (!bbox) return;
        const confidences = (paragraph.words ?? [])
          .map((w) => w.confidence)
          .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
        fragments.push({
          text,
          bbox,
          polygon: (paragraph.boundingBox?.vertices ?? [])
            .filter(
              (v): v is { x: number; y: number } =>
                typeof v?.x === 'number' && typeof v?.y === 'number',
            )
            .map((v) => ({ x: v.x / imageWidth, y: v.y / imageHeight })),
          confidence:
            confidences.length > 0
              ? confidences.reduce((a, b) => a + b, 0) / confidences.length
              : null,
          blockIndex,
          paragraphIndex,
          pageIndex,
        });
      });
    });
  });
  return { fragments, fullText };
}

export interface GoogleVisionOptions {
  apiKey: string;
  /** fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** Abort a hung request after this many ms (default 30s). */
  timeoutMs?: number;
}

const DEFAULT_VISION_TIMEOUT_MS = 30_000;

export class GoogleVisionOcrProvider implements OcrProvider {
  readonly name = 'google-vision';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GoogleVisionOptions) {
    if (!options.apiKey) {
      throw new OcrError(
        ErrorCodes.OCR_PROVIDER_FAILED,
        'Google Vision is selected but GOOGLE_VISION_API_KEY is not set.',
      );
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
  }

  async recognize(input: OcrRecognizeInput): Promise<OcrResult> {
    const body = {
      requests: [
        {
          image: { content: input.imageBytes.toString('base64') },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        },
      ],
    };

    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      res = await this.fetchImpl(`${VISION_ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'AbortError';
      throw new OcrError(
        ErrorCodes.OCR_PROVIDER_FAILED,
        timedOut
          ? `Google Vision request timed out after ${this.timeoutMs}ms.`
          : `Google Vision request failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    let data: VisionResponse;
    try {
      data = (await res.json()) as VisionResponse;
    } catch (err) {
      throw new OcrError(
        ErrorCodes.OCR_RESPONSE_INVALID,
        `Google Vision returned an unreadable response (HTTP ${res.status}).`,
        err,
      );
    }

    const topError = data.error ?? data.responses?.[0]?.error;
    if (!res.ok || topError) {
      const msg = topError?.message ?? `HTTP ${res.status}`;
      // Never include the key in logs/messages.
      throw new OcrError(
        ErrorCodes.OCR_PROVIDER_FAILED,
        `Google Vision OCR failed: ${msg}`,
      );
    }

    const { fragments, fullText } = extractFragments(
      data.responses?.[0]?.fullTextAnnotation,
      input.width,
      input.height,
    );
    if (fragments.length === 0) {
      throw new OcrError(ErrorCodes.OCR_EMPTY_RESULT, 'Google Vision found no text on this page.');
    }

    // Stable deterministic IDs in document order.
    const withIds: OcrFragment[] = fragments.map((f, i) => ({
      ...f,
      id: `ocr_${String(i + 1).padStart(3, '0')}`,
    }));

    return {
      provider: this.name,
      fullText,
      fragments: withIds,
      imageWidth: input.width,
      imageHeight: input.height,
    };
  }
}
