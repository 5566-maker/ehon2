import { Hono } from 'hono';
import sharp from 'sharp';
import {
  CreateBlockSchema,
  ErrorCodes,
  PAGE_ANALYSIS_PROMPT_VERSION,
  PAGE_ENRICHMENT_PROMPT_VERSION,
  ProcessPageSchema,
  UpdatePageSchema,
  type ProcessPageResult,
  type ReaderBlock,
  type TextRegion,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getDatabase } from '../db/connection.js';
import { createBlock, listBlocksByPage } from '../db/blocks.js';
import { listAudioKeysByPageId } from '../db/audio.js';
import { removeAudioFiles } from '../utils/audioFiles.js';
import {
  deletePage,
  getPage,
  getPageOcr,
  listPagesByBook,
  reorderPages,
  renumberPages,
  setPageOcr,
  setPageStatus,
} from '../db/pages.js';
import { refreshBookStatus } from '../db/bookStatus.js';
import { createJob, finishJob } from '../db/jobs.js';
import { fail, ok, zodDetails } from '../utils/response.js';
import { serveMediaFile } from '../utils/media.js';
import { AiError } from '../openai/service.js';
import { replacePageBlocks } from '../db/blocks.js';
import { createOcrProvider, OcrError, regionsForOcrIds, resolveOcrProviderName, unionBbox } from '../ocr/index.js';
import type { OcrFragment } from '../ocr/types.js';

export function pagesRoutes(deps: Deps): Hono {
  const { storage, ai } = deps;
  const app = new Hono();

  app.get('/:id', (c) => {
    const page = getPage(c.req.param('id'));
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    const blocks = listBlocksByPage(page.id);
    return ok(c, {
      page: {
        id: page.id,
        bookId: page.bookId,
        pageNumber: page.pageNumber,
        imageUrl: `/api/pages/${page.id}/image`,
        width: page.width,
        height: page.height,
        ocrStatus: page.ocrStatus,
        processingError: page.processingError,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      },
      blocks,
    });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const page = getPage(id, db);
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = UpdatePageSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid page data.', zodDetails(parsed.error));
    }
    if (parsed.data.pageNumber !== undefined && parsed.data.pageNumber !== page.pageNumber) {
      const pages = listPagesByBook(page.bookId, db);
      const target = parsed.data.pageNumber;
      if (target < 1 || target > pages.length) {
        return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'pageNumber out of range.');
      }
      const others = pages.filter((p) => p.id !== id).map((p) => p.id);
      others.splice(target - 1, 0, id);
      try {
        reorderPages(page.bookId, others, db);
      } catch (err) {
        return fail(c, 400, ErrorCodes.INVALID_REQUEST, (err as Error).message);
      }
    }
    const updated = getPage(id, db);
    return ok(c, { page: updated });
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const page = getPage(id, db);
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    const audioKeys = listAudioKeysByPageId(id, db);
    try {
      storage.removePrefix(`books/${page.bookId}/pages/${page.id}`);
    } catch (err) {
      console.error(`[pages] failed to remove media for page ${id}:`, (err as Error).message);
    }
    deletePage(id, db);
    // Audio rows cascade with the blocks, but their MP3 files live under
    // books/<bookId>/audio/ and need explicit removal.
    removeAudioFiles(storage, audioKeys);
    renumberPages(page.bookId, db);
    refreshBookStatus(page.bookId, db);
    return ok(c, { deleted: true });
  });

  app.get('/:id/image', (c) => {
    const page = getPage(c.req.param('id'));
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    const variant = c.req.query('variant') === 'original' ? 'original' : 'processed';
    const key = variant === 'original' ? page.originalImageKey : page.processedImageKey;
    return serveMediaFile(c, deps, key, page.originalImageKey);
  });

  app.get('/:id/blocks', (c) => {
    const page = getPage(c.req.param('id'));
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    return ok(c, { blocks: listBlocksByPage(page.id) });
  });

  /** Raw cached OCR fragments for the editor debug overlay (no secrets). */
  app.get('/:id/ocr', (c) => {
    const page = getPage(c.req.param('id'));
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    const cache = getPageOcr(page.id);
    if (!cache) return ok(c, { provider: page.ocrProvider, fragments: [] });
    return ok(c, { provider: cache.provider, fragments: cache.fragments });
  });

  app.post('/:id/blocks', async (c) => {
    const id = c.req.param('id');
    const page = getPage(id);
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = CreateBlockSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid text block.', zodDetails(parsed.error));
    }
    const block = createBlock({ ...parsed.data, pageId: id });
    return ok(c, { block }, 201);
  });

  app.post('/:id/process', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const page = getPage(id, db);
    if (!page) return fail(c, 404, ErrorCodes.PAGE_NOT_FOUND, 'Page not found.');
    // A second process request while one is already running would race two
    // OCR/enrichment pipelines on the same page — reject it outright.
    if (page.ocrStatus === 'processing') {
      return fail(c, 409, ErrorCodes.PAGE_ALREADY_PROCESSING, 'This page is already being processed.');
    }

    let body: unknown = {};
    try {
      body = await c.req.json().catch(() => ({}));
    } catch {
      body = {};
    }
    const parsed = ProcessPageSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid request.', zodDetails(parsed.error));
    }

    const ocrProviderName = resolveOcrProviderName(deps.env);
    const promptVersion =
      ocrProviderName === 'google' ? PAGE_ENRICHMENT_PROMPT_VERSION : PAGE_ANALYSIS_PROMPT_VERSION;
    const job = createJob(
      'page',
      id,
      JSON.stringify({ promptVersion, ocrProvider: ocrProviderName }),
      db,
    );
    setPageStatus(id, 'processing', null, db);
    refreshBookStatus(page.bookId, db);

    const imageKey = page.processedImageKey ?? page.originalImageKey;
    if (!storage.exists(imageKey)) {
      const msg = 'Page image is missing from storage.';
      setPageStatus(id, 'failed', msg, db);
      finishJob(job.id, 'failed', ErrorCodes.STORAGE_ERROR, msg, db);
      refreshBookStatus(page.bookId, db);
      return fail(c, 500, ErrorCodes.STORAGE_ERROR, msg);
    }

    // Tracks which stage failed so the error gets the right code.
    let stage: 'ocr' | 'enrichment' | 'legacy' = 'legacy';
    try {
      const bytes = storage.read(imageKey);

      if (ocrProviderName === 'google') {
        // ---- Stage 1: OCR, cached in pages.ocr_json unless forced ----
        stage = 'ocr';
        const useCache = !parsed.data.forceOcr && !parsed.data.force;
        let cache = useCache ? getPageOcr(id, db) : null;
        if (cache && cache.fragments.length === 0) cache = null;

        let fragments: OcrFragment[];
        if (cache) {
          fragments = cache.fragments.map((f) => ({ id: f.id, text: f.text, bbox: f.bbox }));
          console.log(`[pages] reusing cached OCR for page ${id} (${fragments.length} fragments)`);
        } else {
          // Throws OcrError with a helpful message when the key is missing.
          const provider = createOcrProvider(deps.env);
          let width = page.width ?? 0;
          let height = page.height ?? 0;
          if (!width || !height) {
            const meta = await sharp(bytes).metadata();
            width = meta.width ?? 0;
            height = meta.height ?? 0;
          }
          if (!width || !height) {
            throw new OcrError(
              ErrorCodes.OCR_PROVIDER_FAILED,
              'Could not determine the page image dimensions.',
            );
          }
          const ocrResult = await provider.recognize({
            imageBytes: bytes,
            mimeType: 'image/webp',
            width,
            height,
          });
          fragments = ocrResult.fragments;
          setPageOcr(
            id,
            ocrResult.provider,
            {
              provider: ocrResult.provider,
              fragments: fragments.map((f) => ({ id: f.id, text: f.text, bbox: f.bbox })),
            },
            db,
          );
          console.log(
            `[pages] OCR done for page ${id}: ${fragments.length} fragments via ${ocrResult.provider}`,
          );
        }

        // ---- Stage 2: OpenAI enrichment (language only, no geometry) ----
        stage = 'enrichment';
        const enriched = await ai.enrichPage({ imageBytes: bytes, mimeType: 'image/webp', fragments });

        // ---- Stage 3: ocr_ids -> regions, union bbox for legacy compat ----
        const fragById = new Map(fragments.map((f) => [f.id, f]));
        const staleAudioKeys = listAudioKeysByPageId(id, db);
        const blocks = replacePageBlocks(
          id,
          enriched.blocks.map((b) => {
            const regions: TextRegion[] = regionsForOcrIds(b.ocrIds, fragById);
            return {
              blockOrder: b.order,
              originalText: b.originalText,
              normalizedText: b.normalizedText,
              readingText: b.readingText,
              chineseText: b.chineseText,
              englishText: b.englishText,
              explanationZh: b.explanationZh,
              vocabulary: b.vocabulary,
              orientation: b.orientation,
              // Union of OCR regions keeps the legacy single-bbox contract working.
              bbox: unionBbox(regions) ?? { x: 0, y: 0, width: 0, height: 0 },
              regions,
              confidence: b.confidence,
            };
          }),
          db,
        );
        // The replaced blocks (and their cascading audio rows) are gone;
        // remove the orphaned MP3 files too.
        removeAudioFiles(storage, staleAudioKeys);
        setPageStatus(id, 'ready', null, db);
        finishJob(job.id, 'success', null, null, db);
        refreshBookStatus(page.bookId, db);

        const response: ProcessPageResult = {
          pageId: id,
          status: 'ready',
          summary: enriched.pageSummary,
          blocks: blocks.map(
            (b): ReaderBlock => ({
              id: b.id,
              order: b.blockOrder,
              originalText: b.originalText,
              normalizedText: b.normalizedText,
              readingText: b.readingText,
              chineseText: b.chineseText,
              englishText: b.englishText,
              explanationZh: b.explanationZh,
              vocabulary: b.vocabulary,
              orientation: b.orientation,
              bbox: b.bbox,
              regions: b.regions,
            }),
          ),
        };
        return ok(c, response);
      }

      // ---- Legacy fallback: OpenAI does OCR + bboxes (OCR_PROVIDER=openai-legacy) ----
      stage = 'legacy';
      const result = await ai.analyzePage({ imageBytes: bytes, mimeType: 'image/webp' });

      const staleAudioKeys = listAudioKeysByPageId(id, db);
      const blocks = replacePageBlocks(
        id,
        result.blocks.map((b) => ({
          blockOrder: b.order,
          originalText: b.originalText,
          normalizedText: b.normalizedText,
          readingText: b.readingText,
          chineseText: b.chineseText,
          englishText: b.englishText,
          explanationZh: b.explanationZh,
          vocabulary: b.vocabulary,
          orientation: b.orientation,
          bbox: b.bbox,
          regions: [],
          confidence: b.confidence,
        })),
        db,
      );
      removeAudioFiles(storage, staleAudioKeys);
      setPageStatus(id, 'ready', null, db);
      finishJob(job.id, 'success', null, null, db);
      refreshBookStatus(page.bookId, db);

      const response: ProcessPageResult = {
        pageId: id,
        status: 'ready',
        summary: result.pageSummary,
        blocks: blocks.map(
          (b): ReaderBlock => ({
            id: b.id,
            order: b.blockOrder,
            originalText: b.originalText,
            normalizedText: b.normalizedText,
            readingText: b.readingText,
            chineseText: b.chineseText,
            englishText: b.englishText,
            explanationZh: b.explanationZh,
            vocabulary: b.vocabulary,
            orientation: b.orientation,
            bbox: b.bbox,
            regions: b.regions,
          }),
        ),
      };
      return ok(c, response);
    } catch (err) {
      let code: string = ErrorCodes.PAGE_ANALYSIS_FAILED;
      let status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 502 | 503 = 502;
      let safeMessage = 'Unable to analyze this page.';
      if (err instanceof OcrError) {
        code = err.code;
        if (err.code === ErrorCodes.OCR_EMPTY_RESULT) {
          safeMessage = 'No text was detected on this page.';
        } else if (!deps.env.GOOGLE_VISION_API_KEY) {
          safeMessage =
            'Text detection is not configured. Set GOOGLE_VISION_API_KEY on the server, ' +
            'or use OCR_PROVIDER=openai-legacy.';
        } else {
          safeMessage = 'Text detection failed for this page.';
        }
        console.error(`[pages] OCR failed for page ${id}:`, err.message);
      } else if (err instanceof AiError) {
        if (
          err.code === ErrorCodes.AI_RESPONSE_INVALID ||
          err.code === ErrorCodes.INVALID_OCR_REFERENCE
        ) {
          code = err.code;
          status = 422;
          safeMessage = 'The AI returned data in an unexpected format.';
        } else if (stage === 'enrichment') {
          code = ErrorCodes.PAGE_ENRICHMENT_FAILED;
          safeMessage = 'Unable to enrich this page.';
        } else {
          code = err.code;
        }
        console.error(`[pages] process failed for page ${id}:`, err.message);
      } else {
        console.error(
          `[pages] process failed for page ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      setPageStatus(id, 'failed', safeMessage, db);
      finishJob(job.id, 'failed', code, safeMessage, db);
      refreshBookStatus(page.bookId, db);
      return fail(c, status, code, `${safeMessage} You can retry or add text blocks manually.`);
    }
  });

  return app;
}
