import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '@ehon2/shared';
import { openDatabase, closeDatabase, getDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createBook } from '../db/books.js';
import { createPage, setPageStatus } from '../db/pages.js';
import { pagesRoutes } from './pages.js';

/**
 * Route-level tests for pagesRoutes with stubbed deps (no network, no AI).
 * Each test opens its own throwaway SQLite file.
 */

function stubDeps() {
  return {
    env: { OCR_PROVIDER: 'google', GOOGLE_VISION_ENABLED: false } as never,
    storage: { exists: () => false } as never,
    ai: {} as never,
  };
}

describe('POST /pages/:id/process duplicate guard', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-routes-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 409 PAGE_ALREADY_PROCESSING when the page is already processing', async () => {
    const db = getDatabase();
    const book = createBook({ title: 't', language: 'ja' }, db);
    const page = createPage(
      { bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 1, height: 1, mimeType: 'image/webp' },
      db,
    );
    setPageStatus(page.id, 'processing', null, db);

    const app = pagesRoutes(stubDeps());
    const res = await app.request(`/${page.id}/process`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.success, false);
    assert.equal(body.error.code, ErrorCodes.PAGE_ALREADY_PROCESSING);
  });

  it('does not reject a page that is not processing', async () => {
    const db = getDatabase();
    const book = createBook({ title: 't', language: 'ja' }, db);
    const page = createPage(
      { bookId: book.id, pageNumber: 1, originalImageKey: 'b', processedImageKey: null, width: 1, height: 1, mimeType: 'image/webp' },
      db,
    );
    // 'pending' passes the guard; the stubbed storage then reports the image
    // as missing, which proves the request went past the duplicate check.
    const app = pagesRoutes(stubDeps());
    const res = await app.request(`/${page.id}/process`, { method: 'POST' });
    assert.notEqual(res.status, 409);
    assert.equal(res.status, 500);
  });
});
