import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { getDatabase } from './connection.js';
import { newId } from '../utils/ids.js';
import { hoursFromNowIso, nowIso } from '../utils/time.js';

/** SHA-256 hex of a raw session token. Only the hash is stored. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionRecord {
  id: string;
  sessionTokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  userAgent: string | null;
}

export function createSession(
  tokenHash: string,
  ttlHours: number,
  userAgent: string | null,
  db: DatabaseSync = getDatabase(),
): SessionRecord {
  const now = nowIso();
  const id = newId();
  const expiresAt = hoursFromNowIso(ttlHours);
  db.prepare(
    `INSERT INTO sessions (id, session_token_hash, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, tokenHash, now, expiresAt, now, userAgent);
  return { id, sessionTokenHash: tokenHash, createdAt: now, expiresAt, lastSeenAt: now, userAgent };
}

export function findSessionByTokenHash(
  tokenHash: string,
  db: DatabaseSync = getDatabase(),
): SessionRecord | null {
  const row = db
    .prepare(
      `SELECT id, session_token_hash, created_at, expires_at, last_seen_at, user_agent
       FROM sessions WHERE session_token_hash = ?`,
    )
    .get(tokenHash) as
    | {
        id: string;
        session_token_hash: string;
        created_at: string;
        expires_at: string;
        last_seen_at: string | null;
        user_agent: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    sessionTokenHash: row.session_token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
  };
}

/** Returns the session only if it exists and has not expired. */
export function findValidSession(tokenHash: string, db: DatabaseSync = getDatabase()): SessionRecord | null {
  const session = findSessionByTokenHash(tokenHash, db);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    deleteSessionById(session.id, db);
    return null;
  }
  return session;
}

export function touchSession(id: string, db: DatabaseSync = getDatabase()): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
}

export function deleteSessionByTokenHash(tokenHash: string, db: DatabaseSync = getDatabase()): void {
  db.prepare('DELETE FROM sessions WHERE session_token_hash = ?').run(tokenHash);
}

export function deleteSessionById(id: string, db: DatabaseSync = getDatabase()): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Housekeeping: remove expired sessions. Returns rows deleted. */
export function purgeExpiredSessions(db: DatabaseSync = getDatabase()): number {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  return Number(result.changes);
}
