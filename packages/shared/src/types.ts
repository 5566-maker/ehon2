/**
 * @ehon2/shared — domain types shared by the server and the web app.
 *
 * These mirror the SQLite schema in migrations/0001_initial.sql and the
 * TypeScript domain types from the technical specification.
 */

export type BookStatus = 'draft' | 'uploading' | 'processing' | 'ready' | 'failed';

export type PageProcessingStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type TextOrientation = 'horizontal' | 'vertical' | 'mixed' | 'unknown';

export type ReaderLanguage = 'ja' | 'zh' | 'en';

export type ProcessingJobStatus = 'pending' | 'running' | 'success' | 'failed';

export type ProcessingEntityType = 'cover' | 'page' | 'audio';

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One clickable region of a text block.
 * Coordinates are normalized 0..1 (origin top-left), owned by the OCR
 * provider — OpenAI never invents or modifies these.
 */
export interface TextRegion {
  ocrId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalized, provider-neutral OCR cache stored on pages.ocr_json. */
export interface PageOcrCache {
  provider: string;
  fragments: {
    id: string;
    text: string;
    bbox: BBox;
  }[];
}

export interface VocabularyItem {
  word: string;
  reading?: string | null;
  meaning_zh: string;
}

export interface Book {
  id: string;
  title: string | null;
  subtitle: string | null;
  titleReading: string | null;
  author: string | null;
  illustrator: string | null;
  publisher: string | null;
  isbn: string | null;
  language: string;
  coverImageKey: string | null;
  coverProcessedImageKey: string | null;
  status: BookStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BookPage {
  id: string;
  bookId: string;
  pageNumber: number;
  originalImageKey: string;
  processedImageKey: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  ocrStatus: PageProcessingStatus;
  processingError: string | null;
  /** Which OCR provider produced the cached ocr_json ('google-vision' | null). */
  ocrProvider: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TextBlock {
  id: string;
  pageId: string;
  blockOrder: number;
  originalText: string;
  normalizedText: string | null;
  readingText: string | null;
  chineseText: string | null;
  englishText: string | null;
  explanationZh: string | null;
  vocabulary: VocabularyItem[];
  orientation: TextOrientation;
  bbox: BBox;
  /** Precise click regions (from OCR). Empty for legacy bbox-only blocks. */
  regions: TextRegion[];
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AudioAsset {
  id: string;
  blockId: string;
  language: ReaderLanguage;
  voice: string;
  speed: number;
  audioKey: string;
  contentType: string;
  textHash: string;
  createdAt: string;
}

/** Result of the AI cover-metadata analysis (validated, vendor-neutral). */
export interface CoverMetadata {
  title: string | null;
  subtitle: string | null;
  titleReading: string | null;
  author: string | null;
  illustrator: string | null;
  publisher: string | null;
  isbn: string | null;
  language: string;
  confidence: number;
}

/** One validated block returned by the AI page analysis. */
export interface PageAnalysisBlock {
  order: number;
  originalText: string;
  normalizedText: string | null;
  readingText: string | null;
  chineseText: string | null;
  englishText: string | null;
  explanationZh: string | null;
  vocabulary: VocabularyItem[];
  orientation: TextOrientation;
  bbox: BBox;
  confidence: number;
}

export interface PageAnalysisResult {
  pageSummary: string | null;
  blocks: PageAnalysisBlock[];
}

/**
 * One validated reading block from OpenAI enrichment.
 * References OCR fragment IDs; geometry comes from the OCR cache, never here.
 */
export interface EnrichedPageBlock {
  order: number;
  ocrIds: string[];
  originalText: string;
  normalizedText: string | null;
  readingText: string | null;
  chineseText: string | null;
  englishText: string | null;
  explanationZh: string | null;
  vocabulary: VocabularyItem[];
  orientation: TextOrientation;
  confidence: number;
}

export interface PageEnrichmentResult {
  pageSummary: string | null;
  blocks: EnrichedPageBlock[];
}

/* ---------------- API DTOs (request/response shapes) ---------------- */

export interface BookListItem {
  id: string;
  title: string | null;
  coverUrl: string | null;
  pageCount: number;
  readyPageCount: number;
  status: BookStatus;
  updatedAt: string;
}

export interface PageSummary {
  id: string;
  pageNumber: number;
  thumbnailUrl: string;
  ocrStatus: PageProcessingStatus;
  blockCount: number;
}

export interface BookDetail {
  id: string;
  title: string | null;
  subtitle: string | null;
  titleReading: string | null;
  author: string | null;
  illustrator: string | null;
  publisher: string | null;
  isbn: string | null;
  language: string;
  coverUrl: string | null;
  status: BookStatus;
  createdAt: string;
  updatedAt: string;
  pages: PageSummary[];
  counts: {
    total: number;
    ready: number;
    processing: number;
    failed: number;
  };
}

export interface ReaderBlock {
  id: string;
  order: number;
  originalText: string;
  normalizedText: string | null;
  readingText: string | null;
  chineseText: string | null;
  englishText: string | null;
  explanationZh: string | null;
  vocabulary: VocabularyItem[];
  orientation: TextOrientation;
  bbox: BBox;
  /** Precise click regions; readers fall back to bbox when empty. */
  regions: TextRegion[];
}

export interface ReaderPage {
  id: string;
  pageNumber: number;
  imageUrl: string;
  ocrStatus: PageProcessingStatus;
  blocks: ReaderBlock[];
}

export interface ReaderData {
  book: { id: string; title: string | null };
  pages: ReaderPage[];
}

export interface AudioRequestResult {
  audioUrl: string;
  cached: boolean;
  language: ReaderLanguage;
  voice: string;
  speed: number;
}

export interface ProcessPageResult {
  pageId: string;
  status: PageProcessingStatus;
  summary: string | null;
  blocks: ReaderBlock[];
}

/* ---------------- API envelope ---------------- */

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;
