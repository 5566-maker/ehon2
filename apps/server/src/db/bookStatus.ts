import type { DatabaseSync } from 'node:sqlite';
import { getBook, setBookStatus } from './books.js';
import { deriveBookStatus } from './pages.js';
import { getDatabase } from './connection.js';

/** Recompute and persist the book-level status from its pages. */
export function refreshBookStatus(bookId: string, db: DatabaseSync = getDatabase()): void {
  const book = getBook(bookId, db);
  if (!book) return;
  const next = deriveBookStatus(bookId, book.status, db);
  if (next !== book.status) setBookStatus(bookId, next, db);
}
