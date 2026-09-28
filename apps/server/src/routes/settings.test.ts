import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes, type ReaderLanguage } from '@ehon2/shared';
import { openDatabase, closeDatabase, getDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { setSetting } from '../db/settings.js';
import { settingsRoutes } from './settings.js';

/**
 * Route-level tests for settingsRoutes with stubbed deps (no network, no AI).
 * Each describe block opens its own throwaway SQLite file.
 */

function stubDeps(env: Record<string, unknown> = {}) {
  return {
    env: { TTS_PROVIDER: 'kokoro', ...env } as never,
    storage: {} as never,
    ai: {} as never,
  };
}

interface TtsBody {
  voices: Record<ReaderLanguage, { effective: string; source: string; options: { id: string }[] }>;
  speeds: Record<
    ReaderLanguage,
    { effective: number; source: string; options: number[] }
  >;
}

describe('GET /settings/tts', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-settings-routes-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports built-in defaults with source=default', async () => {
    const app = settingsRoutes(stubDeps());
    const res = await app.request('/tts');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; data: TtsBody };
    assert.equal(body.success, true);
    assert.equal(body.data.voices.ja.effective, 'jf_alpha');
    assert.equal(body.data.voices.ja.source, 'default');
    assert.equal(body.data.voices.zh.effective, 'zf_xiaobei');
    assert.equal(body.data.voices.en.effective, 'af_heart');
    assert.ok(body.data.voices.zh.options.some((o) => o.id === 'zm_yunxia'));
    assert.equal(body.data.speeds.ja.effective, 1);
    assert.equal(body.data.speeds.ja.source, 'default');
    assert.deepEqual(body.data.speeds.ja.options.length, 16);
    assert.equal(body.data.speeds.ja.options[0], 0.5);
    assert.equal(body.data.speeds.ja.options[15], 2);
  });

  it('reports the env override with source=env', async () => {
    const app = settingsRoutes(stubDeps({ KOKORO_ZH_VOICE: 'zm_yunxi', TTS_SPEED_ZH: 1.2 }));
    const res = await app.request('/tts');
    const body = (await res.json()) as { success: boolean; data: TtsBody };
    assert.equal(body.data.voices.zh.effective, 'zm_yunxi');
    assert.equal(body.data.voices.zh.source, 'env');
    assert.equal(body.data.speeds.zh.effective, 1.2);
    assert.equal(body.data.speeds.zh.source, 'env');
  });

  it('reports the settings-page override with source=settings (beats env)', async () => {
    setSetting('tts.voice.ja', 'jm_kumo', getDatabase());
    setSetting('tts.speed.ja', '1.5', getDatabase());
    const app = settingsRoutes(stubDeps({ KOKORO_JA_VOICE: 'jf_nezumi', TTS_SPEED_JA: 1.3 }));
    const res = await app.request('/tts');
    const body = (await res.json()) as { success: boolean; data: TtsBody };
    assert.equal(body.data.voices.ja.effective, 'jm_kumo');
    assert.equal(body.data.voices.ja.source, 'settings');
    assert.equal(body.data.speeds.ja.effective, 1.5);
    assert.equal(body.data.speeds.ja.source, 'settings');
  });
});

describe('PUT /settings/tts', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-settings-put-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists valid voices and speeds and returns the updated info', async () => {
    const app = settingsRoutes(stubDeps());
    const res = await app.request('/tts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        voices: { zh: 'zm_yunyang', en: 'am_adam' },
        speeds: { ja: 1.2, zh: 0.8 },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; data: TtsBody };
    assert.equal(body.data.voices.zh.effective, 'zm_yunyang');
    assert.equal(body.data.voices.zh.source, 'settings');
    assert.equal(body.data.voices.en.effective, 'am_adam');
    // Untouched language keeps its default.
    assert.equal(body.data.voices.ja.effective, 'jf_alpha');
    assert.equal(body.data.speeds.ja.effective, 1.2);
    assert.equal(body.data.speeds.ja.source, 'settings');
    assert.equal(body.data.speeds.zh.effective, 0.8);
    assert.equal(body.data.speeds.en.effective, 1);
  });

  it('rejects an unknown voice id with 400 and writes nothing', async () => {
    const app = settingsRoutes(stubDeps());
    const res = await app.request('/tts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voices: { ja: 'not_a_voice' } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.error.code, ErrorCodes.INVALID_REQUEST);
  });

  it('rejects a voice id that belongs to another language', async () => {
    const app = settingsRoutes(stubDeps());
    const res = await app.request('/tts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voices: { ja: 'zf_xiaobei' } }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects out-of-range speeds with 400', async () => {
    const app = settingsRoutes(stubDeps());
    for (const speed of [2.5, 0.3, 0, 3]) {
      const res = await app.request('/tts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speeds: { ja: speed } }),
      });
      assert.equal(res.status, 400, `speed ${speed} should be rejected`);
    }
  });

  it('rejects non-step and non-numeric speeds with 400', async () => {
    const app = settingsRoutes(stubDeps());
    for (const speed of [1.25, 0.55, 'fast', null, NaN]) {
      const res = await app.request('/tts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speeds: { ja: speed } }),
      });
      assert.equal(res.status, 400, `speed ${String(speed)} should be rejected`);
    }
  });

  it('accepts boundary speeds 0.5 and 2.0', async () => {
    const app = settingsRoutes(stubDeps());
    const res = await app.request('/tts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speeds: { ja: 0.5, en: 2.0 } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; data: TtsBody };
    assert.equal(body.data.speeds.ja.effective, 0.5);
    assert.equal(body.data.speeds.en.effective, 2.0);
  });

  it('rejects malformed bodies', async () => {
    const app = settingsRoutes(stubDeps());
    const res = await app.request('/tts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voices: { ja: 42 } }),
    });
    assert.equal(res.status, 400);
  });
});
