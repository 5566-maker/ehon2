import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeKey,
  audioKey,
  bookCoverOriginalKey,
  bookCoverProcessedKey,
  bookDirPrefix,
  pageOriginalKey,
  pageProcessedKey,
} from '@ehon2/shared';

describe('media key functions', () => {
  it('builds cover keys', () => {
    assert.equal(bookCoverOriginalKey('book1', 'jpg'), 'books/book1/cover/original.jpg');
    assert.equal(bookCoverProcessedKey('book1'), 'books/book1/cover/processed.webp');
  });

  it('builds page keys', () => {
    assert.equal(pageOriginalKey('book1', 'page9', 'png'), 'books/book1/pages/page9/original.png');
    assert.equal(pageProcessedKey('book1', 'page9'), 'books/book1/pages/page9/processed.webp');
  });

  it('builds audio keys with a truncated text hash', () => {
    const key = audioKey('book1', 'block7', 'ja', 'abcdef0123456789');
    assert.equal(key, 'books/book1/audio/block7-ja-abcdef012345.mp3');
  });

  it('builds book dir prefix', () => {
    assert.equal(bookDirPrefix('book1'), 'books/book1');
  });

  it('rejects unsafe ids', () => {
    assert.throws(() => bookDirPrefix('../evil'));
    assert.throws(() => pageOriginalKey('book1', '../../x', 'jpg'));
    assert.throws(() => audioKey('book1', 'b', 'ja', 'zzz'));
  });

  it('assertSafeKey blocks traversal', () => {
    assert.throws(() => assertSafeKey('../x'));
    assert.throws(() => assertSafeKey('/abs/path'));
    assert.throws(() => assertSafeKey('a\\b'));
    assert.doesNotThrow(() => assertSafeKey('books/b1/pages/p1/processed.webp'));
  });
});
