import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import {
  COVER_ANALYSIS_PROMPT_VERSION,
  CoverAnalysisResultSchema,
  ErrorCodes,
  PAGE_ANALYSIS_PROMPT_VERSION,
  PAGE_ENRICHMENT_PROMPT_VERSION,
  PageAnalysisResultSchema,
  PageEnrichmentResultSchema,
  type BBox,
  type CoverMetadata,
  type EnrichedPageBlock,
  type PageAnalysisBlock,
  type PageAnalysisResult,
  type PageEnrichmentResult,
  type ReaderLanguage,
} from '@ehon2/shared';
import type { AppEnv } from '../env.js';
import {
  KokoroTtsProvider,
  OpenAiTtsProvider,
  TtsError,
  resolveVoice as resolveOpenAiVoice,
  type TtsProvider,
  type TtsSynthesisResult,
} from '../tts/providers.js';
import type { OcrFragment } from '../ocr/types.js';
import {
  buildEnrichmentUserPrompt,
  COVER_SYSTEM_PROMPT,
  COVER_USER_PROMPT,
  PAGE_ENRICHMENT_SYSTEM_PROMPT,
  PAGE_SYSTEM_PROMPT,
  PAGE_USER_PROMPT,
} from './prompts.js';

/**
 * Central OpenAI service. Route handlers never assemble OpenAI requests
 * directly — everything goes through this abstraction so the provider can
 * be swapped later (see technical spec §42/§43).
 */

import { AiError } from './errors.js';
export { AiError };

function toDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * Models that reject a custom `temperature` (only the default is accepted).
 * gpt-5.6-luna / gpt-5.6-sol answer HTTP 400
 * "Unsupported value: 'temperature' does not support 0 with this model"
 * when the field is present, so it must be omitted entirely rather than
 * forced to 1. The gpt-5 family and the o-series reasoning models share
 * this constraint; everything else keeps temperature 0 for determinism.
 */
const FIXED_TEMPERATURE_MODEL_PATTERNS = [/^gpt-5([.-]|$)/i, /^o[134]/i];

export function supportsCustomTemperature(model: string): boolean {
  return !FIXED_TEMPERATURE_MODEL_PATTERNS.some((re) => re.test(model.trim()));
}

/**
 * Enrichment failures worth exactly one retry with the fallback model: the
 * provider request itself failed (network, 4xx/5xx) or the model returned
 * something unusable (empty, non-JSON, schema mismatch). Local validation
 * failures such as unknown ocr_id references are deterministic checks
 * against our own input and are not retried.
 */
const RETRYABLE_ENRICHMENT_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.PAGE_ANALYSIS_FAILED,
  ErrorCodes.AI_RESPONSE_INVALID,
]);

function isRetryableEnrichmentError(err: unknown): boolean {
  return err instanceof AiError && RETRYABLE_ENRICHMENT_CODES.has(err.code);
}

/** Single-line error summary for logs — no prompts, images, or secrets. */
function shortError(err: unknown, max = 160): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? `${msg.slice(0, max)}\u2026` : msg;
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
  /** fetch implementation used by the Kokoro TTS provider (tests). */
  kokoroFetch?: typeof fetch;
}

export class AiService {
  private readonly client: OpenAI;

  constructor(
    private readonly env: AppEnv,
    options: AiServiceOptions = {},
  ) {
    this.client =
      options.client ?? new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.OPENAI_TIMEOUT_MS });
    this.kokoroFetch = options.kokoroFetch;
  }

  private readonly kokoroFetch?: typeof fetch;

  private describeError(err: unknown): string {
    if (err instanceof OpenAI.APIError) {
      // The SDK message names the concrete problem (bad model, bad schema,
      // bad image, …) and carries no secrets — include it for diagnosis.
      const code = (err as { code?: unknown }).code;
      return (
        `OpenAI API error (status ${err.status ?? 'unknown'}, ` +
        `type ${err.type ?? 'unknown'}, code ${code ?? 'unknown'}): ${err.message}`
      );
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
        // gpt-5.6-luna / gpt-5.6-sol 400 on any explicit temperature — omit it.
        ...(supportsCustomTemperature(args.model) ? { temperature: 0 } : {}),
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
                reading_text: {
                  type: ['string', 'null'],
                  description:
                    'Full kana reading of the block: hiragana/katakana only, no kanji.',
                },
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
   * Enrich OCR fragments into reading blocks.
   *
   * The model receives the page image plus OCR fragment ids/text/geometry,
   * but must NOT return any geometry — every returned ocr_id is validated
   * against the input and unknown ids are rejected.
   *
   * If OPENAI_ENRICHMENT_FALLBACK is configured and the primary model fails
   * with a provider error or an invalid AI response, enrichment is retried
   * exactly once with the fallback model. Google Vision OCR is never
   * retried; local validation errors are not retried either.
   */
  async enrichPage(input: {
    imageBytes: Buffer;
    mimeType: string;
    fragments: OcrFragment[];
  }): Promise<PageEnrichmentResult> {
    const primary = this.env.OPENAI_VISION_MODEL;
    const fallback = this.env.OPENAI_ENRICHMENT_FALLBACK;
    try {
      return await this.enrichPageWithModel(input, primary);
    } catch (err) {
      if (!isRetryableEnrichmentError(err) || !fallback || fallback === primary) throw err;
      const code = err instanceof AiError ? err.code : 'UNKNOWN';
      console.warn(
        `[enrichment] primary model ${primary} failed (${code}): ${shortError(err)}; ` +
          `retrying once with fallback ${fallback}`,
      );
      return await this.enrichPageWithModel(input, fallback);
    }
  }

  /** One enrichment attempt with a single model — no retry inside. */
  private async enrichPageWithModel(
    input: {
      imageBytes: Buffer;
      mimeType: string;
      fragments: OcrFragment[];
    },
    model: string,
  ): Promise<PageEnrichmentResult> {
    const knownIds = new Set(input.fragments.map((f) => f.id));
    const fragmentsJson = JSON.stringify(
      input.fragments.map((f) => ({
        id: f.id,
        text: f.text,
        // Layout context only — the model must not return geometry.
        bbox: { x: +f.bbox.x.toFixed(4), y: +f.bbox.y.toFixed(4) },
      })),
    );

    const raw = await this.chatJson({
      model,
      system: PAGE_ENRICHMENT_SYSTEM_PROMPT,
      user: buildEnrichmentUserPrompt(fragmentsJson),
      image: { bytes: input.imageBytes, mimeType: input.mimeType },
      schemaName: 'page_enrichment',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['page_summary', 'reading_blocks'],
        properties: {
          page_summary: { type: ['string', 'null'] },
          reading_blocks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'order', 'ocr_ids', 'original_text', 'normalized_text', 'reading_text',
                'chinese_text', 'english_text', 'explanation_zh',
                'vocabulary', 'orientation', 'confidence',
              ],
              properties: {
                order: { type: 'integer', minimum: 1 },
                ocr_ids: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
                original_text: { type: 'string' },
                normalized_text: { type: ['string', 'null'] },
                reading_text: {
                  type: ['string', 'null'],
                  description:
                    'Full kana reading of the block: hiragana/katakana only, no kanji.',
                },
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
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      },
    });

    const parsed = PageEnrichmentResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AiError(ErrorCodes.AI_RESPONSE_INVALID, 'Page enrichment returned invalid data', parsed.error);
    }

    // Validate ocr_id references: unknown ids are rejected, never silently kept.
    const sorted = [...parsed.data.reading_blocks].sort((a, b) => a.order - b.order);
    const blocks: EnrichedPageBlock[] = [];
    for (const b of sorted) {
      const unknown = b.ocr_ids.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        throw new AiError(
          ErrorCodes.INVALID_OCR_REFERENCE,
          `Page enrichment referenced unknown OCR fragment ids: ${unknown.slice(0, 5).join(', ')}`,
        );
      }
      // De-duplicate ids within a block while preserving order.
      const ocrIds = [...new Set(b.ocr_ids)];
      blocks.push({
        order: blocks.length + 1,
        ocrIds,
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
        confidence: b.confidence,
      });
    }
    console.log(`[enrichment] prompt=${PAGE_ENRICHMENT_PROMPT_VERSION} blocks=${blocks.length}`);
    return { pageSummary: parsed.data.page_summary, blocks };
  }

  /**
   * Synthesize speech. Returns the MP3 bytes plus which provider actually
   * generated them (Kokoro primary, one OpenAI fallback on retryable
   * failures). Callers must derive cache identity from the returned
   * provider/voice, not from the requested ones.
   *
   * For Japanese the caller passes selectTtsText() output, which prefers the
   * kana reading_text so kanji is never misread as Chinese.
   *
   * Provider chain: TTS_PROVIDER=kokoro tries Kokoro once, then falls back
   * once to OpenAI on connection/timeout/5xx/invalid-audio failures.
   * TTS_PROVIDER=openai uses OpenAI directly. Empty text is a local
   * validation error and never triggers fallback.
   */
  async synthesizeSpeech(input: {
    text: string;
    language: ReaderLanguage;
    voice: string;
    speed: number;
  }): Promise<TtsSynthesisResult> {
    const text = input.text?.trim();
    if (!text) {
      throw new AiError(ErrorCodes.TTS_TEXT_UNAVAILABLE, 'No text to synthesize.');
    }
    const providers = this.ttsProviders();
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      // The OpenAI fallback always uses an OpenAI voice for the language;
      // a Kokoro-specific voice id must not leak into the OpenAI request.
      const voice = provider.name === 'openai' && i > 0
        ? resolveOpenAiVoice(this.env, input.language, 'default')
        : input.voice;
      try {
        const audio = await provider.synthesize({ ...input, text, voice });
        return {
          audio,
          provider: provider.name,
          voice,
          model: provider.name === 'kokoro' ? this.env.KOKORO_TTS_MODEL : this.env.OPENAI_TTS_MODEL,
        };
      } catch (err) {
        const code = err instanceof AiError ? err.code : ErrorCodes.TTS_GENERATION_FAILED;
        const msg = err instanceof Error ? err.message : String(err);
        const last = i === providers.length - 1;
        if (!(err instanceof TtsError) || !err.retryable || last) {
          if (!last) {
            console.warn(`[tts] provider ${provider.name} failed non-retryably (${code}); not falling back`);
          }
          throw err instanceof AiError ? err : new AiError(code, msg, err);
        }
        const next = providers[i + 1]!.name;
        console.warn(
          `[tts] provider ${provider.name} failed (${code}): ${msg.slice(0, 160)}; ` +
            `falling back once to ${next}`,
        );
      }
    }
    throw new AiError(ErrorCodes.TTS_GENERATION_FAILED, 'TTS failed: no provider available.');
  }

  /** Ordered TTS provider chain for the configured TTS_PROVIDER. */
  private ttsProviders(): TtsProvider[] {
    const openai = new OpenAiTtsProvider(this.client, this.env.OPENAI_TTS_MODEL);
    if (this.env.TTS_PROVIDER === 'openai') return [openai];
    return [
      new KokoroTtsProvider({
        baseUrl: this.env.KOKORO_BASE_URL,
        model: this.env.KOKORO_TTS_MODEL,
        fetchFn: this.kokoroFetch,
      }),
      openai,
    ];
  }
}

export { COVER_ANALYSIS_PROMPT_VERSION, PAGE_ANALYSIS_PROMPT_VERSION };

/** SHA-256 hex of the final TTS input text (part of the audio cache key). */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Select the TTS input text (technical spec §19, amended 2026-09-28). */
export function selectTtsText(
  block: {
    readingText: string | null;
    normalizedText: string | null;
    originalText: string;
    chineseText: string | null;
    englishText: string | null;
  },
  language: ReaderLanguage,
): string | null {
  switch (language) {
    case 'ja': {
      // Prefer the kana reading: raw kanji makes providers guess the language,
      // and simplified-form glyphs (e.g. 人员输送车) get read as Chinese.
      // Pure kana is unambiguous for both Kokoro and OpenAI.
      const reading = block.readingText?.trim();
      return reading ? reading : (block.normalizedText ?? block.originalText);
    }
    case 'zh':
      return block.chineseText;
    case 'en':
      return block.englishText;
  }
}

/** Resolve "default" to the configured voice for the language. (moved to tts/providers.ts) */
export { resolveVoice } from '../tts/providers.js';
