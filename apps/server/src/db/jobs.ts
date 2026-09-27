import type { DatabaseSync } from 'node:sqlite';
import type { ProcessingEntityType } from '@ehon2/shared';
import { getDatabase } from './connection.js';
import { mapJob, type ProcessingJob, type Row } from './rows.js';
import { newId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';

export function createJob(
  entityType: ProcessingEntityType,
  entityId: string,
  payloadJson?: string,
  db: DatabaseSync = getDatabase(),
): ProcessingJob {
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO processing_jobs (id, entity_type, entity_id, status, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
  ).run(id, entityType, entityId, payloadJson ?? null, now, now);
  const row = db.prepare('SELECT * FROM processing_jobs WHERE id = ?').get(id) as Row;
  return mapJob(row);
}

export function finishJob(
  id: string,
  status: 'success' | 'failed',
  errorCode?: string | null,
  errorMessage?: string | null,
  db: DatabaseSync = getDatabase(),
): void {
  db.prepare(
    `UPDATE processing_jobs SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
  ).run(status, errorCode ?? null, errorMessage ?? null, nowIso(), id);
}
