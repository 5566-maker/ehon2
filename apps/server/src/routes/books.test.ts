import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ErrorCodes } from '@ehon2/shared';
import { openDatabase, closeDatabase, getDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createBook } from '../db/books.js';
import { listPagesByBook } from '../db/pages.js';
import { FileStorage } from '../storage/files.js';
import { booksRoutes } from './books.js';

/**
 * Two-phase batch upload tests for booksRoutes (real FileStorage + tmp DB,
 * no network, no AI).
 */

function stubEnv() {
  return { UPLOAD_MAX_MB: 10, UPLOAD_MAX_FILES: 20, IMAGE_MAX_DIM: 256, IMAGE_QUALITY: 80 } as never;
}

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();
}

function uploadForm(images: { name: string; data: Buffer; type: string }[]): FormData {
  const form = new FormData();
  for (const img of images) {
    form.append('files', new Blob([new Uint8Array(img.data)], { type: img.type }), img.name);
  }
  return form;
}

describe('POST /books/:id/pages two-phase upload', () => {
  let dir: string;
  let storageDir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-books-test-'));
    storageDir = mkdtempSync(join(tmpdir(), 'ehon2-books-storage-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('creates all pages when every file is valid', async () => {
    const db = getDatabase();
    const book = createBook({ title: 't', language: 'ja' }, db);
    const storage = new FileStorage(storageDir);
    const app = booksRoutes({ env: stubEnv(), storage, ai: {} as never });
    const png = await tinyPng();

    const res = await app.request(`/${book.id}/pages`, {
      method: 'POST',
      body: uploadForm([
        { name: 'a.png', data: png, type: 'image/png' },
        { name: 'b.png', data: png, type: 'image/png' },
      ]),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { success: boolean; data: { pages: { id: string; pageNumber: number }[] } };
    assert.equal(body.success, true);
    assert.deepEqual(body.data.pages.map((p) => p.pageNumber), [1, 2]);
    for (const p of body.data.pages) {
      assert.ok(storage.exists(`books/${book.id}/pages/${p.id}/processed.webp`), 'processed webp stored');
    }
  });

  it('writes nothing when the last file is invalid', async () => {
    const db = getDatabase();
    const book = createBook({ title: 't', language: 'ja' }, db);
    const storage = new FileStorage(storageDir);
    const app = booksRoutes({ env: stubEnv(), storage, ai: {} as never });
    const png = await tinyPng();

    const res = await app.request(`/${book.id}/pages`, {
      method: 'POST',
      body: uploadForm([
        { name: 'a.png', data: png, type: 'image/png' },
        { name: 'b.png', data: png, type: 'image/png' },
        { name: 'bad.txt', data: Buffer.from('not an image'), type: 'text/plain' },
      ]),
    });
    assert.equal(res.status, 415);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.error.code, ErrorCodes.UNSUPPORTED_IMAGE_TYPE);
    // Phase 1 failed before anything persistent was touched.
    assert.deepEqual(listPagesByBook(book.id, db), []);
    assert.ok(!existsSync(join(storageDir, 'books', book.id, 'pages')), 'no page files written');
  });

  it('rolls back the whole batch when a storage write fails mid-batch', async () => {
    const db = getDatabase();
    const book = createBook({ title: 't', language: 'ja' }, db);
    const real = new FileStorage(storageDir);
    let writes = 0;
    const flakyStorage = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'write') {
          return (key: string, data: Buffer) => {
            writes += 1;
            // Fail on the 3rd write: page 1 fully persisted, page 2's original fails.
            if (writes >= 3) throw new Error('simulated disk failure');
            target.write(key, data);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FileStorage;
    const app = booksRoutes({ env: stubEnv(), storage: flakyStorage, ai: {} as never });
    const png = await tinyPng();

    const res = await app.request(`/${book.id}/pages`, {
      method: 'POST',
      body: uploadForm([
        { name: 'a.png', data: png, type: 'image/png' },
        { name: 'b.png', data: png, type: 'image/png' },
      ]),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.error.code, ErrorCodes.STORAGE_ERROR);
    // The batch was rolled back: no rows, no files left behind.
    assert.deepEqual(listPagesByBook(book.id, db), []);
    const pagesDir = join(storageDir, 'books', book.id, 'pages');
    if (existsSync(pagesDir)) {
      assert.deepEqual(readdirSync(pagesDir), []);
    }
  });
});
