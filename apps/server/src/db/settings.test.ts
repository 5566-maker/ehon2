import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '@ehon2/shared';
import { openDatabase, closeDatabase, getDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { getSetting, setSetting, deleteSetting } from '../db/settings.js';

describe('settings table', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-settings-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for an unset key', () => {
    assert.equal(getSetting('nope', getDatabase()), null);
  });

  it('round-trips set/get and overwrites', () => {
    const db = getDatabase();
    setSetting('tts.voice.ja', 'jf_alpha', db);
    assert.equal(getSetting('tts.voice.ja', db), 'jf_alpha');
    setSetting('tts.voice.ja', 'jm_kumo', db);
    assert.equal(getSetting('tts.voice.ja', db), 'jm_kumo');
  });

  it('deletes a key', () => {
    const db = getDatabase();
    setSetting('tts.voice.zh', 'zf_xiaobei', db);
    deleteSetting('tts.voice.zh', db);
    assert.equal(getSetting('tts.voice.zh', db), null);
  });
});
