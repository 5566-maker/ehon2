import type { DatabaseSync } from 'node:sqlite';
import type { BBox, TextBlock, TextOrientation, TextRegion, VocabularyItem } from '@ehon2/shared';
import { getDatabase, transaction } from './connection.js';
import { mapBlock, type Row } from './rows.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

export interface CreateBlockInput {
  pageId: string;
  blockOrder: number;
  originalText: string;
  normalizedText?: string | null;
  readingText?: string | null;
  chineseText?: string | null;
  englishText?: string | null;
  explanationZh?: string | null;
  vocabulary?: VocabularyItem[];
  orientation?: TextOrientation;
  bbox: BBox;
  /** Precise OCR regions; bbox stays as the legacy/union fallback. */
  regions?: TextRegion[];
  confidence?: number | null;
}

export interface UpdateBlockInput {
  blockOrder?: number;
  originalText?: string;
  normalizedText?: string | null;
  readingText?: string | null;
  chineseText?: string | null;
  englishText?: string | null;
  explanationZh?: string | null;
  vocabulary?: VocabularyItem[];
  orientation?: TextOrientation;
  bbox?: BBox;
  regions?: TextRegion[] | null;
  confidence?: number | null;
}

const COLUMNS =
  'id, page_id, block_order, original_text, normalized_text, reading_text, chinese_text, ' +
  'english_text, explanation_zh, vocabulary_json, orientation, bbox_x, bbox_y, bbox_width, ' +
  'bbox_height, regions_json, confidence, created_at, updated_at';

function insertBlockRow(input: CreateBlockInput, db: DatabaseSync, id: string = newId()): TextBlock {
  const now = nowIso();
  db.prepare(
    `INSERT INTO text_blocks
       (id, page_id, block_order, original_text, normalized_text, reading_text,
        chinese_text, english_text, explanation_zh, vocabulary_json, orientation,
        bbox_x, bbox_y, bbox_width, bbox_height, regions_json, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.pageId,
    input.blockOrder,
    input.originalText,
    input.normalizedText ?? null,
    input.readingText ?? null,
    input.chineseText ?? null,
    input.englishText ?? null,
    input.explanationZh ?? null,
    JSON.stringify(input.vocabulary ?? []),
    input.orientation ?? 'unknown',
    input.bbox.x,
    input.bbox.y,
    input.bbox.width,
    input.bbox.height,
    input.regions && input.regions.length > 0 ? JSON.stringify(input.regions) : null,
    input.confidence ?? null,
    now,
    now,
  );
  const block = getBlock(id, db);
  if (!block) throw new Error('Failed to create text block');
  return block;
}

/**
 * Create a block at the requested order, shifting existing blocks at or
 * after that order up by one (keeps UNIQUE(page_id, block_order)).
 *
 * The shift uses a temporary +OFFSET bump so SQLite's row-by-row UNIQUE
 * check never sees an intermediate collision.
 */
export function createBlock(input: CreateBlockInput, db: DatabaseSync = getDatabase()): TextBlock {
  const ORDER_OFFSET = 1000000;
  return transaction(db, () => {
    const now = nowIso();
    const id = newId();
    db.prepare(
      'UPDATE text_blocks SET block_order = block_order + ?, updated_at = ? WHERE page_id = ?',
    ).run(ORDER_OFFSET, now, input.pageId);
    insertBlockRow(input, db, id);
    // Tail (originally >= requested order) moves down from the temp range with +1.
    db.prepare(
      'UPDATE text_blocks SET block_order = block_order + 1 - ?, updated_at = ? WHERE page_id = ? AND block_order >= ? + ?',
    ).run(ORDER_OFFSET, now, input.pageId, input.blockOrder, ORDER_OFFSET);
    // Head (originally < requested order) moves back down unchanged.
    db.prepare(
      'UPDATE text_blocks SET block_order = block_order - ?, updated_at = ? WHERE page_id = ? AND block_order >= ? AND block_order < ? + ?',
    ).run(ORDER_OFFSET, now, input.pageId, ORDER_OFFSET, input.blockOrder, ORDER_OFFSET);
    const block = getBlock(id, db);
    if (!block) throw new Error('Failed to create text block');
    return block;
  });
}

/** Insert without shifting (used when replacing a whole page result). */
export function insertBlockRaw(input: CreateBlockInput, db: DatabaseSync): TextBlock {
  return insertBlockRow(input, db);
}

export function getBlock(id: string, db: DatabaseSync = getDatabase()): TextBlock | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM text_blocks WHERE id = ?`).get(id) as
    | Row
    | undefined;
  return row ? mapBlock(row) : null;
}

export function listBlocksByPage(pageId: string, db: DatabaseSync = getDatabase()): TextBlock[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM text_blocks WHERE page_id = ? ORDER BY block_order ASC`)
    .all(pageId) as Row[];
  return rows.map(mapBlock);
}

export function countBlocksByPage(pageId: string, db: DatabaseSync = getDatabase()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM text_blocks WHERE page_id = ?')
    .get(pageId) as Row | undefined;
  return Number(row?.n ?? 0);
}

const UPDATABLE: Record<string, string> = {
  blockOrder: 'block_order',
  originalText: 'original_text',
  normalizedText: 'normalized_text',
  readingText: 'reading_text',
  chineseText: 'chinese_text',
  englishText: 'english_text',
  explanationZh: 'explanation_zh',
  vocabulary: 'vocabulary_json',
  orientation: 'orientation',
  confidence: 'confidence',
};

export function updateBlock(
  id: string,
  input: UpdateBlockInput,
  db: DatabaseSync = getDatabase(),
): TextBlock | null {
  return transaction(db, () => {
    const existing = getBlock(id, db);
    if (!existing) return null;

    // Moving order: park the moving block at a negative temp order, shift the
    // range between old and new order, then place the block at its new order.
    // (The negative park avoids UNIQUE(page_id, block_order) collisions.)
    if (input.blockOrder !== undefined && input.blockOrder !== existing.blockOrder) {
      const from = existing.blockOrder;
      const to = input.blockOrder;
      db.prepare('UPDATE text_blocks SET block_order = -1, updated_at = ? WHERE id = ?').run(
        nowIso(),
        id,
      );
      if (to < from) {
        db.prepare(
          'UPDATE text_blocks SET block_order = block_order + 1, updated_at = ? WHERE page_id = ? AND block_order >= ? AND block_order < ?',
        ).run(nowIso(), existing.pageId, to, from);
      } else {
        db.prepare(
          'UPDATE text_blocks SET block_order = block_order - 1, updated_at = ? WHERE page_id = ? AND block_order > ? AND block_order <= ?',
        ).run(nowIso(), existing.pageId, from, to);
      }
    }

    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(UPDATABLE)) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(key === 'vocabulary' ? JSON.stringify(value) : (value as string | number | null));
      }
    }
    if (input.bbox !== undefined) {
      sets.push('bbox_x = ?', 'bbox_y = ?', 'bbox_width = ?', 'bbox_height = ?');
      values.push(input.bbox.x, input.bbox.y, input.bbox.width, input.bbox.height);
    }
    if (input.regions !== undefined) {
      sets.push('regions_json = ?');
      values.push(input.regions && input.regions.length > 0 ? JSON.stringify(input.regions) : null);
    }
    if (input.blockOrder !== undefined && input.blockOrder !== existing.blockOrder) {
      sets.push('block_order = ?');
      values.push(input.blockOrder);
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    values.push(nowIso(), id);
    db.prepare(`UPDATE text_blocks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getBlock(id, db);
  });
}

export function deleteBlock(id: string, db: DatabaseSync = getDatabase()): boolean {
  return transaction(db, () => {
    const existing = getBlock(id, db);
    if (!existing) return false;
    db.prepare('DELETE FROM text_blocks WHERE id = ?').run(id);
    // Renumber the blocks after the deleted one to keep 1..n ordering.
    db.prepare(
      'UPDATE text_blocks SET block_order = block_order - 1, updated_at = ? WHERE page_id = ? AND block_order > ?',
    ).run(nowIso(), existing.pageId, existing.blockOrder);
    return true;
  });
}

/**
 * Atomically replace all blocks of a page (used after successful AI
 * analysis). Returns the new blocks ordered by block_order.
 */
export function replacePageBlocks(
  pageId: string,
  blocks: Omit<CreateBlockInput, 'pageId'>[],
  db: DatabaseSync = getDatabase(),
): TextBlock[] {
  return transaction(db, () => {
    db.prepare('DELETE FROM text_blocks WHERE page_id = ?').run(pageId);
    const created = blocks.map((b, index) =>
      insertBlockRaw({ ...b, pageId, blockOrder: index + 1 }, db),
    );
    return created;
  });
}

/** Resolve the owning book of a text block (needed for audio key layout). */
export function getBlockBook(
  blockId: string,
  db: DatabaseSync = getDatabase(),
): { blockId: string; pageId: string; bookId: string } | null {
  const row = db
    .prepare(
      `SELECT tb.id AS id, tb.page_id AS page_id, p.book_id AS book_id
       FROM text_blocks tb JOIN pages p ON p.id = tb.page_id
       WHERE tb.id = ?`,
    )
    .get(blockId) as Row | undefined;
  if (!row) return null;
  return {
    blockId: String(row.id),
    pageId: String(row.page_id),
    bookId: String(row.book_id),
  };
}
