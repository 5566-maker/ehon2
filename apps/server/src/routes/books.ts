import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import {
  bookCoverOriginalKey,
  bookCoverProcessedKey,
  bookDirPrefix,
  CreateBookSchema,
  ErrorCodes,
  pageOriginalKey,
  pageProcessedKey,
  ReorderPagesSchema,
  UpdateBookSchema,
  type BookDetail,
  type BookListItem,
  type PageSummary,
  type ReaderData,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { getDatabase } from '../db/connection.js';
import {
  createBook,
  deleteBook,
  getBook,
  listBooks,
  setBookCoverKeys,
  setBookCoverMetadata,
  updateBook,
} from '../db/books.js';
import {
  countBlocksByPage,
  listBlocksByPage,
} from '../db/blocks.js';
import {
  createPage,
  listPagesByBook,
  maxPageNumber,
  reorderPages,
} from '../db/pages.js';
import { refreshBookStatus } from '../db/bookStatus.js';
import type { Row } from '../db/rows.js';
import { nowIso } from '../utils/time.js';
import { fail, ok, zodDetails } from '../utils/response.js';
import { serveMediaFile } from '../utils/media.js';
import { processImage, UploadError, validateUpload } from '../images/process.js';
import { COVER_ANALYSIS_PROMPT_VERSION } from '../openai/service.js';
import { AiError } from '../openai/service.js';

function bookListItems(db: DatabaseSync): BookListItem[] {
  const counts = new Map<string, { total: number; ready: number }>();
  const rows = db
    .prepare(
      `SELECT book_id AS book_id, COUNT(*) AS total,
              SUM(CASE WHEN ocr_status = 'ready' THEN 1 ELSE 0 END) AS ready
       FROM pages GROUP BY book_id`,
    )
    .all() as Row[];
  for (const r of rows) {
    counts.set(String(r.book_id), { total: Number(r.total), ready: Number(r.ready ?? 0) });
  }
  return listBooks(db).map((b) => {
    const c = counts.get(b.id) ?? { total: 0, ready: 0 };
    return {
      id: b.id,
      title: b.title,
      coverUrl: b.coverProcessedImageKey ?? b.coverImageKey ? `/api/books/${b.id}/cover/image` : null,
      pageCount: c.total,
      readyPageCount: c.ready,
      status: b.status,
      updatedAt: b.updatedAt,
    };
  });
}

function toBookDetail(bookId: string, db: DatabaseSync): BookDetail | null {
  const book = getBook(bookId, db);
  if (!book) return null;
  const pages = listPagesByBook(bookId, db);
  const summaries: PageSummary[] = pages.map((p) => ({
    id: p.id,
    pageNumber: p.pageNumber,
    thumbnailUrl: `/api/pages/${p.id}/image`,
    ocrStatus: p.ocrStatus,
    blockCount: countBlocksByPage(p.id, db),
  }));
  const counts = {
    total: pages.length,
    ready: pages.filter((p) => p.ocrStatus === 'ready').length,
    processing: pages.filter((p) => p.ocrStatus === 'pending' || p.ocrStatus === 'processing').length,
    failed: pages.filter((p) => p.ocrStatus === 'failed').length,
  };
  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle,
    titleReading: book.titleReading,
    author: book.author,
    illustrator: book.illustrator,
    publisher: book.publisher,
    isbn: book.isbn,
    language: book.language,
    coverUrl:
      book.coverProcessedImageKey ?? book.coverImageKey ? `/api/books/${book.id}/cover/image` : null,
    status: book.status,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    pages: summaries,
    counts,
  };
}

async function readUploadFile(file: File, maxBytes: number) {
  const bytes = Buffer.from(await file.arrayBuffer());
  return validateUpload(file, bytes, maxBytes);
}

export function booksRoutes(deps: Deps): Hono {
  const { env, storage, ai } = deps;
  const app = new Hono();
  const maxBytes = env.UPLOAD_MAX_MB * 1024 * 1024;

  app.get('/', (c) => ok(c, { books: bookListItems(getDatabase()) }));

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = CreateBookSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid book data.', zodDetails(parsed.error));
    }
    const book = createBook({ title: parsed.data.title ?? null, language: parsed.data.language });
    return ok(
      c,
      { book: { id: book.id, title: book.title, language: book.language, status: book.status } },
      201,
    );
  });

  app.get('/:id', (c) => {
    const detail = toBookDetail(c.req.param('id'), getDatabase());
    if (!detail) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    return ok(c, { book: detail });
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = UpdateBookSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid book data.', zodDetails(parsed.error));
    }
    const book = updateBook(id, parsed.data);
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    return ok(c, { book: toBookDetail(id, getDatabase()) });
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const book = getBook(id, db);
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    // Best-effort file cleanup first; DB cascade removes page/block/audio rows.
    try {
      storage.removePrefix(bookDirPrefix(id));
    } catch (err) {
      console.error(`[books] failed to remove media for book ${id}:`, (err as Error).message);
    }
    deleteBook(id, db);
    return ok(c, { deleted: true });
  });

  /* ---------------- cover ---------------- */

  app.post('/:id/cover', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const book = getBook(id, db);
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');

    let form: Record<string, string | File | File[]>;
    try {
      form = await c.req.parseBody();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid multipart body.');
    }
    const file = form['file'];
    if (!(file instanceof File)) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Missing "file" field.');
    }
    let upload;
    try {
      upload = await readUploadFile(file, maxBytes);
    } catch (err) {
      if (err instanceof UploadError) {
        const status = err.code === 'UPLOAD_TOO_LARGE' ? 413 : 415;
        return fail(c, status, ErrorCodes[err.code], err.message);
      }
      throw err;
    }
    let processed;
    try {
      processed = await processImage(upload.bytes, env.IMAGE_MAX_DIM, env.IMAGE_QUALITY);
    } catch {
      return fail(c, 422, ErrorCodes.IMAGE_PROCESSING_FAILED, 'Unable to decode the uploaded image.');
    }
    try {
      storage.write(bookCoverOriginalKey(id, upload.extension), upload.bytes);
      storage.write(bookCoverProcessedKey(id), processed.webp);
    } catch {
      return fail(c, 500, ErrorCodes.STORAGE_ERROR, 'Failed to store the cover image.');
    }
    setBookCoverKeys(id, bookCoverOriginalKey(id, upload.extension), bookCoverProcessedKey(id), db);
    return ok(c, { coverUrl: `/api/books/${id}/cover/image` });
  });

  app.get('/:id/cover/image', (c) => {
    const id = c.req.param('id');
    const book = getBook(id, getDatabase());
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    if (!book.coverImageKey && !book.coverProcessedImageKey) {
      return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'No cover uploaded yet.');
    }
    const variant = c.req.query('variant') === 'original' ? 'original' : 'processed';
    const key = variant === 'original' ? book.coverImageKey : book.coverProcessedImageKey;
    return serveMediaFile(c, deps, key, book.coverImageKey);
  });

  app.post('/:id/cover/analyze', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const book = getBook(id, db);
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    const imageKey = book.coverProcessedImageKey ?? book.coverImageKey;
    if (!imageKey || !storage.exists(imageKey)) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Upload a cover image first.');
    }
    const bytes = storage.read(imageKey);
    let metadata;
    try {
      metadata = await ai.analyzeCover({ imageBytes: bytes, mimeType: 'image/webp' });
    } catch (err) {
      if (err instanceof AiError) {
        const status = err.code === ErrorCodes.AI_RESPONSE_INVALID ? 422 : 502;
        // Surface the provider-level cause (bad key, quota, outage, network).
        // Single-user app: the detail is diagnostic, not a leak.
        console.error(`[cover-analyze] ${err.code}: ${err.message}`);
        return fail(c, status, err.code, `AI 识别失败：${err.message}`);
      }
      throw err;
    }
    // Record the analysis metadata (validated, vendor-neutral). Only fill in
    // blank columns so re-analysis never clobbers manual corrections.
    setBookCoverMetadata(
      id,
      JSON.stringify({ confidence: metadata.confidence, analyzedAt: nowIso(), promptVersion: COVER_ANALYSIS_PROMPT_VERSION }),
      db,
    );
    const patch: Record<string, string | null> = {};
    const current = getBook(id, db);
    if (current) {
      for (const [col, value] of [
        ['title', metadata.title],
        ['subtitle', metadata.subtitle],
        ['titleReading', metadata.titleReading],
        ['author', metadata.author],
        ['illustrator', metadata.illustrator],
        ['publisher', metadata.publisher],
        ['isbn', metadata.isbn],
      ] as const) {
        const existing = current[col] as string | null;
        if ((existing === null || existing === '') && value) patch[col] = value;
      }
      if (Object.keys(patch).length > 0) updateBook(id, patch, db);
    }
    return ok(c, { metadata });
  });

  /* ---------------- pages ---------------- */

  app.post('/:id/pages', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const book = getBook(id, db);
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');

    // NOTE: we use formData() + getAll() here instead of c.req.parseBody(),
    // because parseBody() keeps only the last file when a field repeats.
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid multipart body.');
    }
    const files: File[] = [];
    for (const field of ['files', 'file']) {
      for (const value of form.getAll(field)) {
        if (value instanceof File && value.size > 0) files.push(value);
      }
    }
    if (files.length === 0) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'No image files provided.');
    }
    if (files.length > env.UPLOAD_MAX_FILES) {
      return fail(
        c,
        400,
        ErrorCodes.INVALID_REQUEST,
        `Too many files (max ${env.UPLOAD_MAX_FILES} per request).`,
      );
    }

    const created: { id: string; pageNumber: number; status: string }[] = [];
    let nextNumber = maxPageNumber(id, db) + 1;
    for (const file of files) {
      let upload;
      try {
        upload = await readUploadFile(file, maxBytes);
      } catch (err) {
        if (err instanceof UploadError) {
          const status = err.code === 'UPLOAD_TOO_LARGE' ? 413 : 415;
          return fail(c, status, ErrorCodes[err.code], `${file.name}: ${err.message}`);
        }
        throw err;
      }
      let processed;
      try {
        processed = await processImage(upload.bytes, env.IMAGE_MAX_DIM, env.IMAGE_QUALITY);
      } catch {
        return fail(c, 422, ErrorCodes.IMAGE_PROCESSING_FAILED, `Unable to decode ${file.name}.`);
      }
      const pageNumber = nextNumber++;
      // Page ids are random; create the row first to obtain a stable id for keys.
      const page = createPage({
        bookId: id,
        pageNumber,
        originalImageKey: pageOriginalKey(id, 'tmp', upload.extension),
        processedImageKey: null,
        width: processed.width,
        height: processed.height,
        mimeType: 'image/webp',
      });
      try {
        storage.write(pageOriginalKey(id, page.id, upload.extension), upload.bytes);
        storage.write(pageProcessedKey(id, page.id), processed.webp);
      } catch {
        // Storage failed: remove the placeholder row so no orphan page remains.
        db.prepare('DELETE FROM pages WHERE id = ?').run(page.id);
        return fail(c, 500, ErrorCodes.STORAGE_ERROR, 'Failed to store the page image.');
      }
      db.prepare('UPDATE pages SET original_image_key = ?, processed_image_key = ? WHERE id = ?').run(
        pageOriginalKey(id, page.id, upload.extension),
        pageProcessedKey(id, page.id),
        page.id,
      );
      created.push({ id: page.id, pageNumber, status: 'pending' });
    }
    refreshBookStatus(id, db);
    return ok(c, { pages: created }, 201);
  });

  app.patch('/:id/pages/reorder', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    if (!getBook(id, db)) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = ReorderPagesSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid reorder request.', zodDetails(parsed.error));
    }
    try {
      reorderPages(id, parsed.data.pageIds, db);
    } catch (err) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, (err as Error).message);
    }
    refreshBookStatus(id, db);
    return ok(c, { pages: listPagesByBook(id, db).map((p) => ({ id: p.id, pageNumber: p.pageNumber })) });
  });

  /* ---------------- reader ---------------- */

  app.get('/:id/reader', (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const book = getBook(id, db);
    if (!book) return fail(c, 404, ErrorCodes.BOOK_NOT_FOUND, 'Book not found.');
    const pages = listPagesByBook(id, db);
    const data: ReaderData = {
      book: { id: book.id, title: book.title },
      pages: pages.map((p) => ({
        id: p.id,
        pageNumber: p.pageNumber,
        imageUrl: `/api/pages/${p.id}/image`,
        ocrStatus: p.ocrStatus,
        blocks: listBlocksByPage(p.id, db).map((b) => ({
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
        })),
      })),
    };
    return ok(c, data);
  });

  return app;
}
