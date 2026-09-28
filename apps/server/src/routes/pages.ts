import { Hono } from 'hono';
import {
  CreateBlockSchema,
  ErrorCodes,
  PAGE_ANALYSIS_PROMPT_VERSION,
  ProcessPageSchema,
  UpdatePageSchema,
  type ProcessPageResult,
  type ReaderBlock,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getDatabase } from '../db/connection.js';
import { createBlock, listBlocksByPage } from '../db/blocks.js';
import {
  deletePage,
  getPage,
  listPagesByBook,
  reorderPages,
  renumberPages,
  setPageStatus,
} from '../db/pages.js';
import { refreshBookStatus } from '../db/bookStatus.js';
import { createJob, finishJob } from '../db/jobs.js';
import { fail, ok, zodDetails } from '../utils/response.js';
import { serveMediaFile } from '../utils/media.js';
import { AiError } from '../openai/service.js';
import { replacePageBlocks } from '../db/blocks.js';

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
    try {
      storage.removePrefix(`books/${page.bookId}/pages/${page.id}`);
    } catch (err) {
      console.error(`[pages] failed to remove media for page ${id}:`, (err as Error).message);
    }
    deletePage(id, db);
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

    const job = createJob('page', id, JSON.stringify({ promptVersion: PAGE_ANALYSIS_PROMPT_VERSION }), db);
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

    try {
      const bytes = storage.read(imageKey);
      const result = await ai.analyzePage({ imageBytes: bytes, mimeType: 'image/webp' });

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
      const code = err instanceof AiError ? err.code : ErrorCodes.PAGE_ANALYSIS_FAILED;
      const safeMessage =
        err instanceof AiError && err.code === ErrorCodes.AI_RESPONSE_INVALID
          ? 'The AI returned data in an unexpected format.'
          : 'Unable to analyze this page.';
      console.error(`[pages] process failed for page ${id}:`, err instanceof Error ? err.message : err);
      setPageStatus(id, 'failed', safeMessage, db);
      finishJob(job.id, 'failed', code, safeMessage, db);
      refreshBookStatus(page.bookId, db);
      const status = code === ErrorCodes.AI_RESPONSE_INVALID ? 422 : 502;
      return fail(c, status, code, `${safeMessage} You can retry or add text blocks manually.`);
    }
  });

  return app;
}
