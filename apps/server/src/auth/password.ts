import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with node:crypto scrypt (zero native dependencies).
 *
 * Stored format: `scrypt$N$r$p$<saltBase64>$<hashBase64>`
 * Example:       `scrypt$16384$8$1$<salt>$<hash>`
 *
 * Use `scripts/hash-password.mjs` to generate AUTH_PASSWORD_HASH.
 */

export const SCRYPT_DEFAULTS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 64,
  saltLen: 32,
} as const;

export interface ParsedScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

export function parseScryptHash(stored: string): ParsedScryptHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 1024 || r < 1 || p < 1) return null;
  try {
    const salt = Buffer.from(parts[4] as string, 'base64');
    const hash = Buffer.from(parts[5] as string, 'base64');
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

export function hashPassword(
  password: string,
  options: { N?: number; r?: number; p?: number; keyLen?: number } = {},
): string {
  const N = options.N ?? SCRYPT_DEFAULTS.N;
  const r = options.r ?? SCRYPT_DEFAULTS.r;
  const p = options.p ?? SCRYPT_DEFAULTS.p;
  const keyLen = options.keyLen ?? SCRYPT_DEFAULTS.keyLen;
  const salt = randomBytes(SCRYPT_DEFAULTS.saltLen);
  const hash = scryptSync(password, salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time password verification. Returns false for malformed hashes. */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseScryptHash(stored);
  if (!parsed) return false;
  const candidate = scryptSync(password, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  });
  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}

/**
 * Constant-time username comparison. The username is not secret, but this
 * avoids leaking prefix information through timing.
 */
export function verifyUsername(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
