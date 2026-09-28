import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from './connection.js';
import { runMigrations } from './migrate.js';
import { createBook, getBook, deleteBook } from './books.js';
import { createPage, getPage, listPagesByBook, reorderPages, renumberPages, deletePage, setPageOcr, getPageOcr } from './pages.js';
import { createBlock, getBlock, listBlocksByPage, updateBlock, deleteBlock } from './blocks.js';
import { createSession, findValidSession, hashSessionToken } from './sessions.js';
import { FileStorage } from '../storage/files.js';
import { removeAudioFiles } from '../utils/audioFiles.js';
import { createAudio, deleteAudioAssetsByBlockId, findAudio, listAudioKeysByBlockId, listAudioKeysByPageId } from './audio.js';

describe('sqlite integration (migrations + repositories)', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
    // Verify idempotency: running again applies nothing.
    const again = runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
    assert.deepEqual(again, []);
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and reads a book', () => {
    const book = createBook({ title: 'ぐりとぐら', language: 'ja' });
    assert.equal(book.title, 'ぐりとぐら');
    assert.equal(book.status, 'draft');
    assert.equal(getBook(book.id)?.id, book.id);
  });

  it('creates pages, reorders them, and renumbers after delete', () => {
    const book = createBook({ title: 't', language: 'ja' });
    const p1 = createPage({ bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 100, height: 100, mimeType: 'image/webp' });
    const p2 = createPage({ bookId: book.id, pageNumber: 2, originalImageKey: 'b', processedImageKey: null, width: 100, height: 100, mimeType: 'image/webp' });
    const p3 = createPage({ bookId: book.id, pageNumber: 3, originalImageKey: 'c', processedImageKey: null, width: 100, height: 100, mimeType: 'image/webp' });

    reorderPages(book.id, [p3.id, p1.id, p2.id]);
    assert.deepEqual(listPagesByBook(book.id).map((p) => p.id), [p3.id, p1.id, p2.id]);

    deletePage(p3.id);
    renumberPages(book.id);
    const rest = listPagesByBook(book.id);
    assert.deepEqual(rest.map((p) => p.pageNumber), [1, 2]);
    assert.deepEqual(rest.map((p) => p.id), [p1.id, p2.id]);
  });

  it('rejects a reorder with missing or duplicate ids', () => {
    const book = createBook({ title: 't', language: 'ja' });
    const p1 = createPage({ bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 1, height: 1, mimeType: 'image/webp' });
    assert.throws(() => reorderPages(book.id, [p1.id, p1.id]));
    assert.throws(() => reorderPages(book.id, []));
  });

  it('creates, updates, and deletes text blocks with order maintenance', () => {
    const book = createBook({ title: 't', language: 'ja' });
    const page = createPage({ bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 1, height: 1, mimeType: 'image/webp' });
    const b1 = createBlock({ pageId: page.id, blockOrder: 1, originalText: 'one', bbox: { x: 0, y: 0, width: 0.5, height: 0.1 } });
    const b2 = createBlock({ pageId: page.id, blockOrder: 1, originalText: 'zero', bbox: { x: 0, y: 0.2, width: 0.5, height: 0.1 } }); // shifts b1
    void b1;
    assert.deepEqual(listBlocksByPage(page.id).map((b) => b.originalText), ['zero', 'one']);

    const moved = updateBlock(b2.id, { blockOrder: 2 });
    assert.equal(moved?.blockOrder, 2);
    assert.deepEqual(listBlocksByPage(page.id).map((b) => b.originalText), ['one', 'zero']);

    assert.equal(deleteBlock(b2.id), true);
    assert.deepEqual(listBlocksByPage(page.id).map((b) => b.blockOrder), [1]);
  });

  it('cascades deletes from book to pages, blocks, and audio', () => {
    const book = createBook({ title: 't', language: 'ja' });
    const page = createPage({ bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 1, height: 1, mimeType: 'image/webp' });
    const block = createBlock({ pageId: page.id, blockOrder: 1, originalText: 'x', bbox: { x: 0, y: 0, width: 0.5, height: 0.1 } });
    createAudio({ blockId: block.id, language: 'ja', voice: 'alloy', speed: 1, audioKey: 'k', textHash: 'h' });
    assert.ok(findAudio(block.id, 'ja', 'alloy', 1, 'h'));

    assert.equal(deleteBook(book.id), true);
    assert.equal(getBook(book.id), null);
    assert.deepEqual(listPagesByBook(book.id), []);
    assert.deepEqual(listBlocksByPage(page.id), []);
    assert.equal(findAudio(block.id, 'ja', 'alloy', 1, 'h'), null);
  });

  it('lists and deletes audio asset keys for orphan cleanup', () => {
    const book = createBook({ title: 't', language: 'ja' });
    const page = createPage({ bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 1, height: 1, mimeType: 'image/webp' });
    const b1 = createBlock({ pageId: page.id, blockOrder: 1, originalText: 'x', bbox: { x: 0, y: 0, width: 0.5, height: 0.1 } });
    const b2 = createBlock({ pageId: page.id, blockOrder: 2, originalText: 'y', bbox: { x: 0, y: 0.2, width: 0.5, height: 0.1 } });
    createAudio({ blockId: b1.id, language: 'ja', voice: 'alloy', speed: 1, audioKey: 'audio/k1.mp3', textHash: 'h1' });
    createAudio({ blockId: b1.id, language: 'zh', voice: 'echo', speed: 1, audioKey: 'audio/k2.mp3', textHash: 'h2' });
    createAudio({ blockId: b2.id, language: 'ja', voice: 'alloy', speed: 1, audioKey: 'audio/k3.mp3', textHash: 'h3' });

    assert.deepEqual(listAudioKeysByBlockId(b1.id).sort(), ['audio/k1.mp3', 'audio/k2.mp3']);
    assert.deepEqual(listAudioKeysByPageId(page.id).sort(), ['audio/k1.mp3', 'audio/k2.mp3', 'audio/k3.mp3']);

    // Deleting a block's audio assets removes the rows and reports the keys.
    assert.deepEqual(deleteAudioAssetsByBlockId(b1.id).sort(), ['audio/k1.mp3', 'audio/k2.mp3']);
    assert.deepEqual(listAudioKeysByBlockId(b1.id), []);
    assert.equal(findAudio(b1.id, 'ja', 'alloy', 1, 'h1'), null);
    // The other block's audio is untouched.
    assert.deepEqual(listAudioKeysByPageId(page.id), ['audio/k3.mp3']);
  });

  it('removeAudioFiles deletes the files and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ehon2-audio-'));
    try {
      const storage = new FileStorage(dir);
      storage.write('books/b1/audio/x.mp3', Buffer.from([1, 2, 3]));
      assert.ok(storage.exists('books/b1/audio/x.mp3'));
      removeAudioFiles(storage, ['books/b1/audio/x.mp3', 'books/b1/audio/missing.mp3']);
      assert.ok(!storage.exists('books/b1/audio/x.mp3'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates sessions and rejects expired ones', () => {
    const s = createSession(hashSessionToken('tok123'), 720, 'test-agent');
    assert.ok(findValidSession(hashSessionToken('tok123')));
    assert.equal(findValidSession(hashSessionToken('nope')), null);

    const expired = createSession(hashSessionToken('old'), -1, null);
    assert.equal(findValidSession(hashSessionToken('old')), null);
    void s;
    void expired;
  });

  it('round-trips block regions and OCR cache', () => {
    const book = createBook({ title: 'regions', language: 'ja' });
    const page = createPage({ bookId: book.id, pageNumber: 1, originalImageKey: 'a', processedImageKey: null, width: 100, height: 100, mimeType: 'image/webp' });

    // Legacy block without regions -> regions [].
    const legacy = createBlock({ pageId: page.id, blockOrder: 1, originalText: 'legacy', bbox: { x: 0, y: 0, width: 0.5, height: 0.1 } });
    assert.deepEqual(getBlock(legacy.id)?.regions, []);

    // Block with regions persists them through create/get/list.
    const withRegions = createBlock({
      pageId: page.id,
      blockOrder: 2,
      originalText: 'multi',
      bbox: { x: 0, y: 0, width: 0.8, height: 0.2 },
      regions: [
        { ocrId: 'ocr_001', x: 0.1, y: 0.05, width: 0.3, height: 0.1 },
        { ocrId: 'ocr_002', x: 0.5, y: 0.05, width: 0.25, height: 0.1 },
      ],
    });
    assert.deepEqual(getBlock(withRegions.id)?.regions, withRegions.regions);
    assert.deepEqual(
      listBlocksByPage(page.id).find((b) => b.id === withRegions.id)?.regions,
      withRegions.regions,
    );

    // Update replaces regions; empty array clears them.
    const updated = updateBlock(withRegions.id, { regions: [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }] });
    assert.deepEqual(updated?.regions, [{ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }]);
    const cleared = updateBlock(withRegions.id, { regions: [] });
    assert.deepEqual(cleared?.regions, []);

    // OCR cache round-trip.
    assert.equal(getPageOcr(page.id), null);
    setPageOcr(page.id, 'google', {
      provider: 'google-vision',
      imageWidth: 100,
      imageHeight: 100,
      fullText: 'abc',
      fragments: [
        { id: 'ocr_001', text: 'abc', bbox: { x: 0, y: 0, width: 0.5, height: 0.2 }, pageIndex: 0, blockIndex: 0, paragraphIndex: 0 },
      ],
    });
    const cached = getPageOcr(page.id);
    assert.equal(cached?.provider, 'google-vision');
    assert.equal(cached?.fragments.length, 1);
    assert.equal(cached?.fragments[0]?.id, 'ocr_001');
    assert.equal(getPage(page.id)?.ocrProvider, 'google');
  });
});
