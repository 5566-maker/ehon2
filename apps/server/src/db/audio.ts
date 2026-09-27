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
