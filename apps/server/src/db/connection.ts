import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: DatabaseSync | null = null;

/**
 * Open (or reuse) the SQLite database file.
 *
 * Applies `PRAGMA journal_mode = WAL` for safer concurrent reads and
 * `PRAGMA foreign_keys = ON` so ON DELETE CASCADE works as the schema
 * expects. Both pragmas are per-connection; node:sqlite keeps a single
 * long-lived connection here.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  // Enforce a busy timeout so short write contention fails gracefully.
  database.exec('PRAGMA busy_timeout = 5000;');
  db = database;
  return database;
}

export function getDatabase(): DatabaseSync {
  if (!db) throw new Error('Database has not been opened yet');
  return db;
}

/** Close the database (used by tests). */
export function closeDatabase(): void {
  db?.close();
  db = null;
}

/** Run fn inside a transaction; roll back and rethrow on error. */
export function transaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    database.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}
