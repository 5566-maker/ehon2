import { randomBytes, randomUUID } from 'node:crypto';

/** UUID v4 for primary keys. */
export function newId(): string {
  return randomUUID();
}

/** base64url-encoded random token (for session tokens). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
