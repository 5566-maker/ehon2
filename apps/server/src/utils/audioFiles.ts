import type { FileStorage } from '../storage/files.js';

/**
 * Best-effort removal of audio files from storage. Used when the owning
 * text block / page is deleted or its text was edited (the cached
 * text_hash is stale). Never throws — a stray file is just an orphan.
 */
export function removeAudioFiles(storage: FileStorage, keys: string[]): void {
  for (const key of keys) {
    try {
      storage.remove(key);
    } catch (err) {
      console.error(`[audio] failed to remove orphan file ${key}:`, (err as Error).message);
    }
  }
}
