import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export interface LoginLimiterOptions {
  /** Failed attempts within the window that trigger a block (default 5). */
  maxFailures?: number;
  /** Sliding window in ms (default 5 minutes). */
  windowMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 5 * 60_000;

/**
 * In-memory sliding-window login rate limiter, keyed by client IP.
 *
 * Block semantics: after `maxFailures` failed attempts inside `windowMs`,
 * the client is blocked (the Nth failure itself still gets a normal 401;
 * the attempt after it gets 429). A successful login clears the client's
 * failure history.
 */
export class LoginLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(options: LoginLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Failure timestamps inside the current window (prunes expired ones). */
  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** True once the client has hit maxFailures within the window. */
  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  /** A successful login clears the client's failure history. */
  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}

/**
 * Best-effort client identity for rate limiting: the first X-Forwarded-For
 * hop (normalized), falling back to the socket address. Only the first hop
 * is used so a spoofed chain can't fan out into many keys.
 */
export function clientKeyFromRequest(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim().toLowerCase();
    if (first) return `ip:${first}`;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return `ip:${String(address).toLowerCase()}`;
  } catch {
    /* not running under @hono/node-server — fall through */
  }
  return 'ip:unknown';
}
