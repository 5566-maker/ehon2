/**
 * Media key helpers.
 *
 * Keys are paths *relative to DATA_DIR* (e.g. `books/<id>/cover/processed.webp`).
 * The server resolves them against DATA_DIR for local file storage.
 *
 * NOTE: the technical specification sketches page-number-based paths
 * (`pages/001/...`). This implementation uses page-ID-based paths instead so
 * that reordering pages never requires renaming files on disk. The key layout
 * is an internal detail; no API contract depends on it.
 */

const BOOK_PREFIX = 'books';

function assertId(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${name} for media key: ${value}`);
  }
}

/** `books/<bookId>/cover/original.<ext>` */
export function bookCoverOriginalKey(bookId: string, extension: string): string {
  assertId(bookId, 'bookId');
  return `${BOOK_PREFIX}/${bookId}/cover/original.${extension}`;
}

/** `books/<bookId>/cover/processed.webp` */
export function bookCoverProcessedKey(bookId: string): string {
  assertId(bookId, 'bookId');
  return `${BOOK_PREFIX}/${bookId}/cover/processed.webp`;
}

/** `books/<bookId>/pages/<pageId>/original.<ext>` */
export function pageOriginalKey(bookId: string, pageId: string, extension: string): string {
  assertId(bookId, 'bookId');
  assertId(pageId, 'pageId');
  return `${BOOK_PREFIX}/${bookId}/pages/${pageId}/original.${extension}`;
}

/** `books/<bookId>/pages/<pageId>/processed.webp` */
export function pageProcessedKey(bookId: string, pageId: string): string {
  assertId(bookId, 'bookId');
  assertId(pageId, 'pageId');
  return `${BOOK_PREFIX}/${bookId}/pages/${pageId}/processed.webp`;
}

/** `books/<bookId>/audio/<blockId>-<language>-<textHash12>.mp3` */
export function audioKey(
  bookId: string,
  blockId: string,
  language: string,
  textHash: string,
): string {
  assertId(bookId, 'bookId');
  assertId(blockId, 'blockId');
  if (!/^[a-z]{2}$/.test(language)) throw new Error(`Invalid language for media key: ${language}`);
  if (!/^[0-9a-f]{8,64}$/.test(textHash)) throw new Error('Invalid textHash for media key');
  return `${BOOK_PREFIX}/${bookId}/audio/${blockId}-${language}-${textHash.slice(0, 12)}.mp3`;
}

/** Directory prefix for everything belonging to one book: `books/<bookId>`. */
export function bookDirPrefix(bookId: string): string {
  assertId(bookId, 'bookId');
  return `${BOOK_PREFIX}/${bookId}`;
}

/** Guard against path traversal for any key coming from the database. */
export function assertSafeKey(key: string): void {
  if (
    key.includes('..') ||
    key.startsWith('/') ||
    key.includes('\\') ||
    !/^[A-Za-z0-9_./-]+$/.test(key)
  ) {
    throw new Error(`Unsafe media key: ${key}`);
  }
}
