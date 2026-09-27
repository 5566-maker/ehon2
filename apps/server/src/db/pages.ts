import type { DatabaseSync } from 'node:sqlite';
import type { BookPage, PageProcessingStatus } from '@ehon2/shared';
import { getDatabase, transaction } from './connection.js';
import { mapPage, type Row } from './rows.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

export interface CreatePageInput {
  bookId: string;
  pageNumber: number;
  originalImageKey: string;
  processedImageKey: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
}

const COLUMNS =
  'id, book_id, page_number, original_image_key, processed_image_key, width, height, ' +
  'mime_type, ocr_status, processing_error, created_at, updated_at';

export function createPage(input: CreatePageInput, db: DatabaseSync = getDatabase()): BookPage {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO pages (id, book_id, page_number, original_image_key, processed_image_key,
                        width, height, mime_type, ocr_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    input.bookId,
    input.pageNumber,
    input.originalImageKey,
    input.processedImageKey,
    input.width,
    input.height,
    input.mimeType,
    now,
    now,
  );
  const page = getPage(id, db);
  if (!page) throw new Error('Failed to create page');
  return page;
}

export function getPage(id: string, db: DatabaseSync = getDatabase()): BookPage | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM pages WHERE id = ?`).get(id) as Row | undefined;
  return row ? mapPage(row) : null;
}

export function listPagesByBook(bookId: string, db: DatabaseSync = getDatabase()): BookPage[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM pages WHERE book_id = ? ORDER BY page_number ASC`)
    .all(bookId) as Row[];
  return rows.map(mapPage);
}

export function countPagesByBook(bookId: string, db: DatabaseSync = getDatabase()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?')
    .get(bookId) as Row | undefined;
  return Number(row?.n ?? 0);
}

export function maxPageNumber(bookId: string, db: DatabaseSync = getDatabase()): number {
  const row = db
    .prepare('SELECT MAX(page_number) AS m FROM pages WHERE book_id = ?')
    .get(bookId) as Row | undefined;
  return Number(row?.m ?? 0);
}

export function setPageStatus(
  id: string,
  status: PageProcessingStatus,
  error: string | null = null,
  db: DatabaseSync = getDatabase(),
): void {
  db.prepare('UPDATE pages SET ocr_status = ?, processing_error = ?, updated_at = ? WHERE id = ?').run(
    status,
    error,
    nowIso(),
    id,
  );
}

export function deletePage(id: string, db: DatabaseSync = getDatabase()): boolean {
  const result = db.prepare('DELETE FROM pages WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Reorder pages of a book. `orderedIds` must contain exactly the current set
 * of page ids (no duplicates, none missing). Uses a temporary negative
 * offset to avoid UNIQUE(book_id, page_number) collisions.
 */
export function reorderPages(
  bookId: string,
  orderedIds: string[],
  db: DatabaseSync = getDatabase(),
): BookPage[] {
  return transaction(db, () => {
    const current = listPagesByBook(bookId, db).map((p) => p.id);
    const sorted = [...orderedIds].sort();
    if (sorted.length !== new Set(orderedIds).size) {
      throw new Error('Duplicate page ids in reorder request');
    }
    if (sorted.join(',') !== [...current].sort().join(',')) {
      throw new Error('Reorder request must include exactly all current page ids');
    }
    db.prepare('UPDATE pages SET page_number = -page_number WHERE book_id = ?').run(bookId);
    orderedIds.forEach((pageId, index) => {
      db.prepare('UPDATE pages SET page_number = ?, updated_at = ? WHERE id = ? AND book_id = ?').run(
        index + 1,
        nowIso(),
        pageId,
        bookId,
      );
    });
    return listPagesByBook(bookId, db);
  });
}

/** Renumber remaining pages 1..n after a deletion. */
export function renumberPages(bookId: string, db: DatabaseSync = getDatabase()): void {
  const pages = listPagesByBook(bookId, db);
  pages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) {
      db.prepare('UPDATE pages SET page_number = ?, updated_at = ? WHERE id = ?').run(
        index + 1,
        nowIso(),
        page.id,
      );
    }
  });
}

/**
 * Derive the book-level status from its pages:
 * draft (no pages) / processing (any pending|processing) /
 * ready (at least one page, all ready) / failed (kept as-is).
 */
export function deriveBookStatus(
  bookId: string,
  current: string,
  db: DatabaseSync = getDatabase(),
): 'draft' | 'processing' | 'ready' | 'failed' {
  if (current === 'failed') return 'failed';
  const rows = db
    .prepare('SELECT ocr_status AS s, COUNT(*) AS n FROM pages WHERE book_id = ? GROUP BY s')
    .all(bookId) as Row[];
  if (rows.length === 0) return 'draft';
  const byStatus = new Map(rows.map((r) => [String(r.s), Number(r.n)]));
  if ((byStatus.get('pending') ?? 0) + (byStatus.get('processing') ?? 0) > 0) return 'processing';
  const ready = byStatus.get('ready') ?? 0;
  return ready > 0 ? 'ready' : 'draft';
}
