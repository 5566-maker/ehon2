import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BBoxSchema,
  CreateBlockSchema,
  AudioRequestSchema,
  LoginRequestSchema,
} from '@ehon2/shared';

describe('BBoxSchema', () => {
  it('accepts a valid bbox', () => {
    const r = BBoxSchema.safeParse({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
    assert.equal(r.success, true);
  });

  it('rejects negative values', () => {
    assert.equal(BBoxSchema.safeParse({ x: -0.1, y: 0, width: 0.3, height: 0.1 }).success, false);
  });

  it('rejects x + width > 1', () => {
    assert.equal(BBoxSchema.safeParse({ x: 0.8, y: 0, width: 0.3, height: 0.1 }).success, false);
  });

  it('rejects y + height > 1', () => {
    assert.equal(BBoxSchema.safeParse({ x: 0, y: 0.9, width: 0.3, height: 0.2 }).success, false);
  });

  it('rejects zero-area boxes', () => {
    assert.equal(BBoxSchema.safeParse({ x: 0.1, y: 0.1, width: 0, height: 0.1 }).success, false);
    assert.equal(
      BBoxSchema.safeParse({ x: 0.1, y: 0.1, width: 0.0001, height: 0.0001 }).success,
      false,
    );
  });

  it('rejects values above 1', () => {
    assert.equal(BBoxSchema.safeParse({ x: 0, y: 0, width: 1.5, height: 0.1 }).success, false);
  });
});

describe('API request schemas', () => {
  it('LoginRequestSchema requires non-empty username/password', () => {
    assert.equal(LoginRequestSchema.safeParse({ username: 'a', password: 'b' }).success, true);
    assert.equal(LoginRequestSchema.safeParse({ username: '', password: 'b' }).success, false);
    assert.equal(LoginRequestSchema.safeParse({ username: 'a' }).success, false);
  });

  it('CreateBlockSchema requires originalText and a valid bbox', () => {
    const base = {
      blockOrder: 1,
      originalText: 'こんにちは',
      orientation: 'horizontal' as const,
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
    };
    assert.equal(CreateBlockSchema.safeParse(base).success, true);
    assert.equal(
      CreateBlockSchema.safeParse({ ...base, originalText: '' }).success,
      false,
    );
    assert.equal(
      CreateBlockSchema.safeParse({ ...base, bbox: { x: 2, y: 0, width: 0.1, height: 0.1 } }).success,
      false,
    );
  });

  it('AudioRequestSchema defaults voice/speed and clamps speed range', () => {
    const r = AudioRequestSchema.safeParse({ language: 'ja' });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.voice, 'default');
      assert.equal(r.data.speed, 1);
    }
    assert.equal(AudioRequestSchema.safeParse({ language: 'ja', speed: 3 }).success, false);
    assert.equal(AudioRequestSchema.safeParse({ language: 'fr' }).success, false);
  });
});
