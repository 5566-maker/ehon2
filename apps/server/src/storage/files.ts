import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { assertSafeKey } from '@ehon2/shared';

/**
 * Local file storage. Media keys are paths relative to DATA_DIR
 * (e.g. `books/<id>/cover/processed.webp`); this module resolves them to
 * absolute paths and guards against path traversal.
 */
export class FileStorage {
  constructor(private readonly dataDir: string) {}

  resolve(key: string): string {
    assertSafeKey(key);
    const abs = resolve(this.dataDir, key);
    const root = resolve(this.dataDir) + sep;
    if (!abs.startsWith(root)) throw new Error(`Unsafe media key: ${key}`);
    return abs;
  }

  exists(key: string): boolean {
    try {
      return statSync(this.resolve(key)).isFile();
    } catch {
      return false;
    }
  }

  read(key: string): Buffer {
    return readFileSync(this.resolve(key));
  }

  write(key: string, data: Buffer | Uint8Array): void {
    const abs = this.resolve(key);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }

  /** Best-effort recursive removal of a book's whole directory. */
  removePrefix(prefix: string): void {
    const abs = this.resolve(prefix);
    rmSync(abs, { recursive: true, force: true });
  }

  size(key: string): number {
    return statSync(this.resolve(key)).size;
  }
}
