import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './connection.js';

/** Read a settings value; null when unset. */
export function getSetting(key: string, db: DatabaseSync = getDatabase()): string | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Upsert a settings value. */
export function setSetting(key: string, value: string, db: DatabaseSync = getDatabase()): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value);
}

/** Remove a settings value. */
export function deleteSetting(key: string, db: DatabaseSync = getDatabase()): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
