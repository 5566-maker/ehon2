import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './connection.js';
import { nowIso } from '../utils/time.js';

/**
 * Reset pages/jobs left in "processing"/"running" by an interrupted run
 * (e.g. the server restarted mid-OCR) so they don't sit in "processing"
 * forever. Only rows older than `staleMinutes` are touched — a fresh,
 * actively running job is never reset.
 */
export function recoverStaleProcessing(
  db: DatabaseSync = getDatabase(),
  staleMinutes: number,
): { pages: number; jobs: number } {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const now = nowIso();
  const message = 'Processing was interrupted before it finished. You can retry.';
  const pages = db
    .prepare(
      `UPDATE pages SET ocr_status = 'failed', processing_error = ?, updated_at = ?
       WHERE ocr_status = 'processing' AND updated_at < ?`,
    )
    .run(message, now, cutoff).changes;
  const jobs = db
    .prepare(
      `UPDATE processing_jobs
       SET status = 'failed', error_code = 'PAGE_ANALYSIS_FAILED', error_message = ?, updated_at = ?
       WHERE status = 'running' AND updated_at < ?`,
    )
    .run(message, now, cutoff).changes;
  return { pages: Number(pages ?? 0), jobs: Number(jobs ?? 0) };
}
