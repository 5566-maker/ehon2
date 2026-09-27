import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import {
  COVER_ANALYSIS_PROMPT_VERSION,
  CoverAnalysisResultSchema,
  ErrorCodes,
  PAGE_ANALYSIS_PROMPT_VERSION,
  PageAnalysisResultSchema,
  type BBox,
  type CoverMetadata,
  type PageAnalysisBlock,
  type PageAnalysisResult,
  type ReaderLanguage,
} from '@ehon2/shared';
import type { AppEnv } from '../env.js';
import {
  COVER_SYSTEM_PROMPT,
  COVER_USER_PROMPT,
  PAGE_SYSTEM_PROMPT,
  PAGE_USER_PROMPT,
} from './prompts.js';

/**
 * Central OpenAI service. Route handlers never assemble OpenAI requests
 * directly — everything goes through this abstraction so the provider can
 * be swapped later (see technical spec §42/§43).
 */

export class AiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

function toDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/** Clamp a raw AI bbox into valid 0..1 bounds; returns null if unusable. */
export function sanitizeBbox(raw: { x: number; y: number; width: number; height: number }): BBox | null {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN);
  let x = clamp(raw.x);
  let y = clamp(raw.y);
  let width = clamp(raw.width);
  let height = clamp(raw.height);
  if ([x, y, width, height].some((v) => !Number.isFinite(v))) return null;
  if (x + width > 1) width = 1 - x;
  if (y + height > 1) height = 1 - y;
  if (width * height < 1e-6) return null;
  return { x, y, width, height };
}

export interface AiServiceOptions {
  client?: OpenAI;
}

export class AiService {
  private readonly client: OpenAI;

  constructor(
    private readonly env: AppEnv,
    options: AiServiceOptions = {},
  ) {
    this.client = options.client ?? new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  private describeError(err: unknown): string {
    if (err instanceof OpenAI.APIError) {
      // Never leak raw auth details; keep a short server-side summary.
      return `OpenAI API error (status ${err.status ?? 'unknown'}, type ${err.type ?? 'unknown'})`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private async chatJson(args: {
    model: string;
    system: string;
    user: string;
    image: { bytes: Buffer; mimeType: string };
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<unknown> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: args.model,
        temperature: 0,
        messages: [
          { role: 'system', content: args.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: args.user },
              {
                type: 'image_url',
                image_url: { url: toDataUrl(args.image.bytes, args.image.mimeType), detail: 'high' },
              },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: args.schemaName, strict: true, schema: args.schema },
        },
      });
    } catch (err) {
      throw new AiError(ErrorCodes.PAGE_ANALYSIS_FAILED, `AI request failed: ${this.describeError(err)}`, err);
    }
    const text = completion.choices[0]?.message?.content;
    if (!text) {
      throw new AiError(ErrorCodes.AI_RESPONSE_INVALID, 'AI returned an empty response');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new AiError(ErrorCodes.AI_RESPONSE_INVALID, 'AI returned invalid JSON', err);
    }
  }

  async analyzeCover(input: { imageBytes: Buffer; mimeType: string }): Promise<CoverMetadata> {
    let raw: unknown;
    try {
      raw = await this.chatJson({
        model: this.env.OPENAI_VISION_MODEL,
        system: COVER_SYSTEM_PROMPT,
        user: COVER_USER_PROMPT,
        image: { bytes: input.imageBytes, mimeType: input.mimeType },
        schemaName: 'cover_metadata',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'title', 'subtitle', 'title_reading', 'author', 'illustrator',
            'publisher', 'isbn', 'language', 'confidence',
          ],
          properties: {
            title: { type: ['string', 'null'] },
            subtitle: { type: ['string', 'null'] },
            title_reading: { type: ['string', 'null'] },
            author: { type: ['string', 'null'] },
            illustrator: { type: ['string', 'null'] },
            publisher: { type: ['string', 'null'] },
            isbn: { type: ['string', 'null'] },
            language: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      });
    } catch (err) {
      if (err instanceof AiError && err.code === ErrorCodes.PAGE_ANALYSIS_FAILED) {
        throw new AiError(ErrorCodes.COVER_ANALYSIS_FAILED, `Cover analysis failed: ${err.message}`, err);
      }
      throw err;
    }
    const parsed = CoverAnalysisResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AiError(ErrorCodes.AI_RESPONSE_INVALID, 'Cover analysis returned invalid data', parsed.error);
    }
    const r = parsed.data;
    return {
      title: r.title,
      subtitle: r.subtitle,
      titleReading: r.title_reading,
      author: r.author,
      illustrator: r.illustrator,
      publisher: r.publisher,
      isbn: r.isbn,
      language: r.language,
      confidence: r.confidence,
    };
  }

  async analyzePage(input: { imageBytes: Buffer; mimeType: string }): Promise<PageAnalysisResult> {
    const raw = await this.chatJson({
      model: this.env.OPENAI_VISION_MODEL,
      system: PAGE_SYSTEM_PROMPT,
      user: PAGE_USER_PROMPT,
      image: { bytes: input.imageBytes, mimeType: input.mimeType },
      schemaName: 'page_analysis',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['page_summary', 'blocks'],
        properties: {
          page_summary: { type: ['string', 'null'] },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'order', 'original_text', 'normalized_text', 'reading_text',
                'chinese_text', 'english_text', 'explanation_zh',
                'vocabulary', 'orientation', 'bbox', 'confidence',
              ],
              properties: {
                order: { type: 'integer', minimum: 1 },
                original_text: { type: 'string' },
                normalized_text: { type: ['string', 'null'] },
                reading_text: { type: ['string', 'null'] },
                chinese_text: { type: ['string', 'null'] },
                english_text: { type: ['string', 'null'] },
                explanation_zh: { type: ['string', 'null'] },
                vocabulary: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['word', 'reading', 'meaning_zh'],
                    properties: {
                      word: { type: 'string' },
                      reading: { type: ['string', 'null'] },
                      meaning_zh: { type: 'string' },
                    },
                  },
                },
                orientation: { type: 'string', enum: ['horizontal', 'vertical', 'mixed', 'unknown'] },
                bbox: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['x', 'y', 'width', 'height'],
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                  },
                },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      },
    });

    const parsed = PageAnalysisResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AiError(ErrorCodes.AI_RESPONSE_INVALID, 'Page analysis returned invalid data', parsed.error);
    }

    // Normalize: sort by AI-provided order, sanitize bboxes, reassign 1..n.
    const sorted = [...parsed.data.blocks].sort((a, b) => a.order - b.order);
    const blocks: PageAnalysisBlock[] = [];
    for (const b of sorted) {
      const bbox = sanitizeBbox(b.bbox);
      if (!bbox) {
        throw new AiError(
          ErrorCodes.AI_RESPONSE_INVALID,
          'Page analysis returned an unusable bounding box',
        );
      }
      blocks.push({
        order: blocks.length + 1,
        originalText: b.original_text,
        normalizedText: b.normalized_text,
        readingText: b.reading_text,
        chineseText: b.chinese_text,
        englishText: b.english_text,
        explanationZh: b.explanation_zh,
        vocabulary: b.vocabulary.map((v) => ({
          word: v.word,
          reading: v.reading ?? null,
          meaning_zh: v.meaning_zh,
        })),
        orientation: b.orientation,
        bbox,
        confidence: b.confidence,
      });
    }
    return { pageSummary: parsed.data.page_summary, blocks };
  }

  /**
   * Synthesize speech. Returns MP3 bytes.
   * For Japanese the caller must pass normalized/original text (never reading_text).
   */
  async synthesizeSpeech(input: {
    text: string;
    language: ReaderLanguage;
    voice: string;
    speed: number;
  }): Promise<Buffer> {
    let response;
    try {
      response = await this.client.audio.speech.create({
        model: this.env.OPENAI_TTS_MODEL,
        voice: input.voice as 'alloy',
        input: input.text,
        speed: input.speed,
        response_format: 'mp3',
      });
    } catch (err) {
      throw new AiError(ErrorCodes.TTS_GENERATION_FAILED, `TTS failed: ${this.describeError(err)}`, err);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export { COVER_ANALYSIS_PROMPT_VERSION, PAGE_ANALYSIS_PROMPT_VERSION };

/** SHA-256 hex of the final TTS input text (part of the audio cache key). */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Select the TTS input text per technical spec §19. */
export function selectTtsText(
  block: { normalizedText: string | null; originalText: string; chineseText: string | null; englishText: string | null },
  language: ReaderLanguage,
): string | null {
  switch (language) {
    case 'ja':
      return block.normalizedText ?? block.originalText;
    case 'zh':
      return block.chineseText;
    case 'en':
      return block.englishText;
  }
}

/** Resolve "default" to the configured voice for the language. */
export function resolveVoice(env: AppEnv, language: ReaderLanguage, voice: string): string {
  if (voice !== 'default') return voice;
  switch (language) {
    case 'ja':
      return env.DEFAULT_JA_VOICE;
    case 'zh':
      return env.DEFAULT_ZH_VOICE;
    case 'en':
      return env.DEFAULT_EN_VOICE;
  }
}
