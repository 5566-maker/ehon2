import type { DatabaseSync } from 'node:sqlite';
import type { Book, BookStatus } from '@ehon2/shared';
import { getDatabase } from './connection.js';
import { mapBook, type Row } from './rows.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

export interface CreateBookInput {
  title?: string | null;
  language: string;
}

export interface UpdateBookInput {
  title?: string | null;
  subtitle?: string | null;
  titleReading?: string | null;
  author?: string | null;
  illustrator?: string | null;
  publisher?: string | null;
  isbn?: string | null;
  language?: string;
}

const COLUMNS =
  'id, title, subtitle, title_reading, author, illustrator, publisher, isbn, language, ' +
  'cover_image_key, cover_processed_image_key, cover_metadata_json, status, created_at, updated_at';

const UPDATABLE: Record<keyof UpdateBookInput, string> = {
  title: 'title',
  subtitle: 'subtitle',
  titleReading: 'title_reading',
  author: 'author',
  illustrator: 'illustrator',
  publisher: 'publisher',
  isbn: 'isbn',
  language: 'language',
};

export function createBook(input: CreateBookInput, db: DatabaseSync = getDatabase()): Book {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO books (id, title, language, status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(id, input.title ?? null, input.language, now, now);
  const book = getBook(id, db);
  if (!book) throw new Error('Failed to create book');
  return book;
}

export function getBook(id: string, db: DatabaseSync = getDatabase()): Book | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM books WHERE id = ?`).get(id) as Row | undefined;
  return row ? mapBook(row) : null;
}

export function listBooks(db: DatabaseSync = getDatabase()): Book[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM books ORDER BY updated_at DESC`)
    .all() as Row[];
  return rows.map(mapBook);
}

export function updateBook(
  id: string,
  input: UpdateBookInput,
  db: DatabaseSync = getDatabase(),
): Book | null {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const [key, column] of Object.entries(UPDATABLE) as [keyof UpdateBookInput, string][]) {
    if (input[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(input[key] ?? null);
    }
  }
  if (sets.length === 0) return getBook(id, db);
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  const result = db
    .prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
  if (result.changes === 0) return null;
  return getBook(id, db);
}

export function setBookCoverKeys(
  id: string,
  coverImageKey: string,
  coverProcessedImageKey: string,
  db: DatabaseSync = getDatabase(),
): Book | null {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE books SET cover_image_key = ?, cover_processed_image_key = ?, updated_at = ? WHERE id = ?`,
    )
    .run(coverImageKey, coverProcessedImageKey, now, id);
  if (result.changes === 0) return null;
  return getBook(id, db);
}

export function setBookCoverMetadata(
  id: string,
  metadataJson: string,
  db: DatabaseSync = getDatabase(),
): void {
  db.prepare(`UPDATE books SET cover_metadata_json = ?, updated_at = ? WHERE id = ?`).run(
    metadataJson,
    nowIso(),
    id,
  );
}

export function setBookStatus(
  id: string,
  status: BookStatus,
  db: DatabaseSync = getDatabase(),
): void {
  db.prepare(`UPDATE books SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
}

export function deleteBook(id: string, db: DatabaseSync = getDatabase()): boolean {
  const result = db.prepare('DELETE FROM books WHERE id = ?').run(id);
  return result.changes > 0;
}

export function touchBook(id: string, db: DatabaseSync = getDatabase()): void {
  db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}
