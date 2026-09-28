import { z } from 'zod';

/** Relative bounding box in 0..1 coordinates, origin top-left. */
export const BBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .superRefine((box, ctx) => {
    if (!Number.isFinite(box.x + box.y + box.width + box.height)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be finite numbers' });
      return;
    }
    if (box.x + box.width > 1 + 1e-9) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox exceeds right edge' });
    }
    if (box.y + box.height > 1 + 1e-9) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox exceeds bottom edge' });
    }
    // Reject nearly zero-area boxes (spec: "reject nearly zero-area boxes").
    if (box.width * box.height < 1e-6) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox area is too small' });
    }
  });

export const OrientationSchema = z.enum(['horizontal', 'vertical', 'mixed', 'unknown']);

export const ReaderLanguageSchema = z.enum(['ja', 'zh', 'en']);

export const VocabularyItemSchema = z.object({
  word: z.string().min(1).max(200),
  reading: z.string().max(500).nullable().optional(),
  meaning_zh: z.string().min(1).max(1000),
});

/* ---------------- API request schemas ---------------- */

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(300),
});

export const CreateBookSchema = z.object({
  title: z.string().trim().max(300).nullable().optional(),
  language: z.string().trim().min(2).max(20).default('ja'),
});

export const UpdateBookSchema = z.object({
  title: z.string().trim().max(300).nullable().optional(),
  subtitle: z.string().trim().max(300).nullable().optional(),
  titleReading: z.string().trim().max(500).nullable().optional(),
  author: z.string().trim().max(300).nullable().optional(),
  illustrator: z.string().trim().max(300).nullable().optional(),
  publisher: z.string().trim().max(300).nullable().optional(),
  isbn: z.string().trim().max(50).nullable().optional(),
  language: z.string().trim().min(2).max(20).optional(),
});

export const ReorderPagesSchema = z.object({
  pageIds: z.array(z.string().min(1)).min(1),
});

export const UpdatePageSchema = z.object({
  pageNumber: z.number().int().min(1).optional(),
});

export const ProcessPageSchema = z.object({
  force: z.boolean().optional().default(false),
  /** Re-run OCR even when a cached pages.ocr_json exists. */
  forceOcr: z.boolean().optional().default(false),
});

export const TextRegionSchema = z.object({
  ocrId: z.string().max(40).nullable().optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

export const CreateBlockSchema = z.object({
  blockOrder: z.number().int().min(1),
  originalText: z.string().trim().min(1).max(10000),
  normalizedText: z.string().trim().max(10000).nullable().optional(),
  readingText: z.string().trim().max(10000).nullable().optional(),
  chineseText: z.string().trim().max(10000).nullable().optional(),
  englishText: z.string().trim().max(10000).nullable().optional(),
  explanationZh: z.string().trim().max(10000).nullable().optional(),
  vocabulary: z.array(VocabularyItemSchema).max(50).optional().default([]),
  orientation: OrientationSchema.optional().default('unknown'),
  bbox: BBoxSchema,
  regions: z.array(TextRegionSchema).max(200).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const UpdateBlockSchema = z.object({
  blockOrder: z.number().int().min(1).optional(),
  originalText: z.string().trim().min(1).max(10000).optional(),
  normalizedText: z.string().trim().max(10000).nullable().optional(),
  readingText: z.string().trim().max(10000).nullable().optional(),
  chineseText: z.string().trim().max(10000).nullable().optional(),
  englishText: z.string().trim().max(10000).nullable().optional(),
  explanationZh: z.string().trim().max(10000).nullable().optional(),
  vocabulary: z.array(VocabularyItemSchema).max(50).optional(),
  orientation: OrientationSchema.optional(),
  bbox: BBoxSchema.optional(),
  regions: z.array(TextRegionSchema).max(200).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const AudioRequestSchema = z.object({
  language: ReaderLanguageSchema,
  voice: z.string().min(1).max(100).optional().default('default'),
  speed: z.number().min(0.5).max(2).optional().default(1),
});

/* ---------------- AI structured-output schemas ---------------- */

const NullableText = z.string().nullable();

export const CoverAnalysisResultSchema = z.object({
  title: NullableText,
  subtitle: NullableText,
  title_reading: NullableText,
  author: NullableText,
  illustrator: NullableText,
  publisher: NullableText,
  isbn: NullableText,
  language: z.string().min(1).max(20),
  confidence: z.number().min(0).max(1),
});

export const PageAnalysisBlockSchema = z.object({
  order: z.number().int().min(1),
  original_text: z.string().min(1).max(10000),
  normalized_text: NullableText,
  reading_text: NullableText,
  chinese_text: NullableText,
  english_text: NullableText,
  explanation_zh: NullableText,
  vocabulary: z.array(VocabularyItemSchema).max(50).default([]),
  orientation: OrientationSchema,
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  confidence: z.number().min(0).max(1),
});

export const PageAnalysisResultSchema = z.object({
  page_summary: z.string().max(2000).nullable(),
  blocks: z.array(PageAnalysisBlockSchema).max(500),
});

/**
 * Page enrichment result (Google Vision OCR refactor).
 * OpenAI groups OCR fragments into reading blocks; it NEVER returns geometry.
 */
export const PageEnrichmentBlockSchema = z.object({
  order: z.number().int().min(1),
  ocr_ids: z.array(z.string().min(1).max(40)).min(1).max(200),
  original_text: z.string().min(1).max(10000),
  normalized_text: NullableText,
  reading_text: NullableText,
  chinese_text: NullableText,
  english_text: NullableText,
  explanation_zh: NullableText,
  vocabulary: z.array(VocabularyItemSchema).max(50).default([]),
  orientation: OrientationSchema,
  confidence: z.number().min(0).max(1),
});

export const PageEnrichmentResultSchema = z.object({
  page_summary: z.string().max(2000).nullable(),
  reading_blocks: z.array(PageEnrichmentBlockSchema).max(500),
});

export type PageEnrichmentResultInput = z.infer<typeof PageEnrichmentResultSchema>;

export type CoverAnalysisResultInput = z.infer<typeof CoverAnalysisResultSchema>;
export type PageAnalysisResultInput = z.infer<typeof PageAnalysisResultSchema>;
