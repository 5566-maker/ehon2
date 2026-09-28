import type { DatabaseSync } from 'node:sqlite';
import type { AudioAsset, ReaderLanguage } from '@ehon2/shared';
import { getDatabase } from './connection.js';
import { mapAudio, type Row } from './rows.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

const COLUMNS =
  'id, block_id, language, voice, speed, audio_key, content_type, text_hash, created_at';

export function findAudio(
  blockId: string,
  language: ReaderLanguage,
  voice: string,
  speed: number,
  textHash: string,
  db: DatabaseSync = getDatabase(),
): AudioAsset | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM audio_assets
       WHERE block_id = ? AND language = ? AND voice = ? AND speed = ? AND text_hash = ?`,
    )
    .get(blockId, language, voice, speed, textHash) as Row | undefined;
  return row ? mapAudio(row) : null;
}

export function getAudio(id: string, db: DatabaseSync = getDatabase()): AudioAsset | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM audio_assets WHERE id = ?`).get(id) as
    | Row
    | undefined;
  return row ? mapAudio(row) : null;
}

export function createAudio(
  input: {
    blockId: string;
    language: ReaderLanguage;
    voice: string;
    speed: number;
    audioKey: string;
    textHash: string;
  },
  db: DatabaseSync = getDatabase(),
): AudioAsset {
  const id = newId();
  db.prepare(
    `INSERT INTO audio_assets (id, block_id, language, voice, speed, audio_key, content_type, text_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'audio/mpeg', ?, ?)`,
  ).run(
    id,
    input.blockId,
    input.language,
    input.voice,
    input.speed,
    input.audioKey,
    input.textHash,
    nowIso(),
  );
  const asset = getAudio(id, db);
  if (!asset) throw new Error('Failed to create audio asset');
  return asset;
}

/** Storage keys of every audio asset attached to one text block. */
export function listAudioKeysByBlockId(
  blockId: string,
  db: DatabaseSync = getDatabase(),
): string[] {
  const rows = db
    .prepare('SELECT audio_key AS audio_key FROM audio_assets WHERE block_id = ?')
    .all(blockId) as Row[];
  return rows.map((r) => String(r.audio_key));
}

/** Storage keys of every audio asset attached to any block of a page. */
export function listAudioKeysByPageId(pageId: string, db: DatabaseSync = getDatabase()): string[] {
  const rows = db
    .prepare(
      `SELECT a.audio_key AS audio_key FROM audio_assets a
       JOIN text_blocks b ON b.id = a.block_id
       WHERE b.page_id = ?`,
    )
    .all(pageId) as Row[];
  return rows.map((r) => String(r.audio_key));
}

/**
 * Delete all audio asset rows for a block (e.g. its text was edited, so the
 * cached text_hash is stale). Returns the storage keys so the caller can
 * remove the files too.
 */
export function deleteAudioAssetsByBlockId(
  blockId: string,
  db: DatabaseSync = getDatabase(),
): string[] {
  const keys = listAudioKeysByBlockId(blockId, db);
  db.prepare('DELETE FROM audio_assets WHERE block_id = ?').run(blockId);
  return keys;
}
