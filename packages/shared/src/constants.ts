import type { ReaderLanguage } from './types.js';

/** AI prompt versions (stored with analysis results for future debugging). */
export const PAGE_ANALYSIS_PROMPT_VERSION = 'page-analysis-v2';
export const COVER_ANALYSIS_PROMPT_VERSION = 'cover-analysis-v1';

/** MIME types the server accepts for book images. */
export const ACCEPTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** MIME types that are explicitly rejected with a helpful message. */
export const REJECTED_HEIC_MIMES = ['image/heic', 'image/heif'] as const;

export const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Stable API error codes (from the technical specification). */
export const ErrorCodes = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REQUEST: 'INVALID_REQUEST',
  BOOK_NOT_FOUND: 'BOOK_NOT_FOUND',
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  TEXT_BLOCK_NOT_FOUND: 'TEXT_BLOCK_NOT_FOUND',
  AUDIO_NOT_FOUND: 'AUDIO_NOT_FOUND',
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  UNSUPPORTED_IMAGE_TYPE: 'UNSUPPORTED_IMAGE_TYPE',
  IMAGE_PROCESSING_FAILED: 'IMAGE_PROCESSING_FAILED',
  COVER_ANALYSIS_FAILED: 'COVER_ANALYSIS_FAILED',
  PAGE_ANALYSIS_FAILED: 'PAGE_ANALYSIS_FAILED',
  AI_RESPONSE_INVALID: 'AI_RESPONSE_INVALID',
  OCR_PROVIDER_FAILED: 'OCR_PROVIDER_FAILED',
  OCR_RESPONSE_INVALID: 'OCR_RESPONSE_INVALID',
  OCR_EMPTY_RESULT: 'OCR_EMPTY_RESULT',
  PAGE_ENRICHMENT_FAILED: 'PAGE_ENRICHMENT_FAILED',
  INVALID_OCR_REFERENCE: 'INVALID_OCR_REFERENCE',
  TTS_TEXT_UNAVAILABLE: 'TTS_TEXT_UNAVAILABLE',
  TTS_TEXT_TOO_LONG: 'TTS_TEXT_TOO_LONG',
  TTS_GENERATION_FAILED: 'TTS_GENERATION_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const READER_LANGUAGES: ReaderLanguage[] = ['ja', 'zh', 'en'];

export const LANGUAGE_LABELS: Record<ReaderLanguage, string> = {
  ja: '日本語',
  zh: '中文',
  en: 'English',
};
