import type {
  AudioAsset,
  Book,
  BookPage,
  BookStatus,
  PageProcessingStatus,
  ProcessingEntityType,
  ProcessingJobStatus,
  ReaderLanguage,
  TextBlock,
  TextOrientation,
  TextRegion,
  VocabularyItem,
} from '@ehon2/shared';

/** Raw SQLite row (snake_case columns). */
export type Row = Record<string, string | number | null | Uint8Array>;

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error(`Expected string, got ${typeof v}`);
  return v;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return str(v);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') throw new Error(`Expected number, got ${typeof v}`);
  return v;
}

function parseVocabulary(json: unknown): VocabularyItem[] {
  if (json === null || json === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(str(json));
    return Array.isArray(parsed) ? (parsed as VocabularyItem[]) : [];
  } catch {
    return [];
  }
}

function parseRegions(json: unknown): TextRegion[] {
  if (json === null || json === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(str(json));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is TextRegion =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as TextRegion).x === 'number' &&
        typeof (r as TextRegion).y === 'number' &&
        typeof (r as TextRegion).width === 'number' &&
        typeof (r as TextRegion).height === 'number',
    );
  } catch {
    return [];
  }
}

export function mapBook(row: Row): Book {
  return {
    id: str(row.id),
    title: strOrNull(row.title),
    subtitle: strOrNull(row.subtitle),
    titleReading: strOrNull(row.title_reading),
    author: strOrNull(row.author),
    illustrator: strOrNull(row.illustrator),
    publisher: strOrNull(row.publisher),
    isbn: strOrNull(row.isbn),
    language: str(row.language),
    coverImageKey: strOrNull(row.cover_image_key),
    coverProcessedImageKey: strOrNull(row.cover_processed_image_key),
    status: str(row.status) as BookStatus,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapPage(row: Row): BookPage {
  return {
    id: str(row.id),
    bookId: str(row.book_id),
    pageNumber: numOrNull(row.page_number) ?? 0,
    originalImageKey: str(row.original_image_key),
    processedImageKey: strOrNull(row.processed_image_key),
    width: numOrNull(row.width),
    height: numOrNull(row.height),
    mimeType: strOrNull(row.mime_type),
    ocrStatus: str(row.ocr_status) as PageProcessingStatus,
    processingError: strOrNull(row.processing_error),
    ocrProvider: strOrNull(row.ocr_provider),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapBlock(row: Row): TextBlock {
  return {
    id: str(row.id),
    pageId: str(row.page_id),
    blockOrder: numOrNull(row.block_order) ?? 0,
    originalText: str(row.original_text),
    normalizedText: strOrNull(row.normalized_text),
    readingText: strOrNull(row.reading_text),
    chineseText: strOrNull(row.chinese_text),
    englishText: strOrNull(row.english_text),
    explanationZh: strOrNull(row.explanation_zh),
    vocabulary: parseVocabulary(row.vocabulary_json),
    orientation: str(row.orientation) as TextOrientation,
    bbox: {
      x: numOrNull(row.bbox_x) ?? 0,
      y: numOrNull(row.bbox_y) ?? 0,
      width: numOrNull(row.bbox_width) ?? 0,
      height: numOrNull(row.bbox_height) ?? 0,
    },
    regions: parseRegions(row.regions_json),
    confidence: numOrNull(row.confidence),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapAudio(row: Row): AudioAsset {
  return {
    id: str(row.id),
    blockId: str(row.block_id),
    language: str(row.language) as ReaderLanguage,
    voice: str(row.voice),
    speed: numOrNull(row.speed) ?? 1,
    audioKey: str(row.audio_key),
    contentType: str(row.content_type),
    textHash: str(row.text_hash),
    createdAt: str(row.created_at),
  };
}

export interface ProcessingJob {
  id: string;
  entityType: ProcessingEntityType;
  entityId: string;
  status: ProcessingJobStatus;
  payloadJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapJob(row: Row): ProcessingJob {
  return {
    id: str(row.id),
    entityType: str(row.entity_type) as ProcessingEntityType,
    entityId: str(row.entity_id),
    status: str(row.status) as ProcessingJobStatus,
    payloadJson: strOrNull(row.payload_json),
    errorCode: strOrNull(row.error_code),
    errorMessage: strOrNull(row.error_message),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}
