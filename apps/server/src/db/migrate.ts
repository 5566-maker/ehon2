import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../utils/time.js';
import { transaction } from './connection.js';

/**
 * Applies SQL migrations from a directory, in filename order.
 *
 * Each applied migration is recorded in `schema_migrations` so restarts are
 * idempotent. A migration runs inside a single transaction.
 */

const MIGRATION_FILE_RE = /^\d+_.*\.sql$/;

function resolveMigrationsDir(explicit?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    // Docker runtime layout: /app/deploy/migrations (copied by the Dockerfile)
    join(here, '..', '..', 'migrations'),
    // Monorepo dev layout: <repo>/migrations
    // (src/db -> src -> server -> apps -> repo root)
    join(here, '..', '..', '..', '..', 'migrations'),
  ].filter((c): c is string => !!c);
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    `Migrations directory not found. Tried: ${candidates.join(', ')}. ` +
      'Set MIGRATIONS_DIR to override.',
  );
}

export function runMigrations(db: DatabaseSync, explicitDir?: string): string[] {
  const dir = resolveMigrationsDir(explicitDir);
  mkdirSync(dirname(dir), { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: string }).version),
  );

  const files = readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        nowIso(),
      );
    });
    newlyApplied.push(version);
    console.log(`[migrate] applied ${file}`);
  }
  return newlyApplied;
}
