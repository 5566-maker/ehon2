import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { newToken } from '../utils/ids.js';
import {
  createSession,
  deleteSessionByTokenHash,
  findValidSession,
  hashSessionToken,
  touchSession,
  type SessionRecord,
} from '../db/sessions.js';

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'Lax';
  path: '/';
  maxAge: number;
}

function cookieOptions(env: AppEnv): CookieOptions {
  // Secure cookies require HTTPS. Auto-detect: production defaults to true,
  // local dev (http://localhost) defaults to false. Explicit COOKIE_SECURE
  // env always wins.
  const secure = env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(env.SESSION_TTL_HOURS * 3600),
  };
}

/** Create a session, persist only the token hash, set the cookie. */
export function issueSession(c: Context, env: AppEnv): SessionRecord {
  const token = newToken(32);
  const tokenHash = hashSessionToken(token);
  const userAgent = c.req.header('user-agent') ?? null;
  const session = createSession(tokenHash, env.SESSION_TTL_HOURS, userAgent, undefined);
  setCookie(c, env.SESSION_COOKIE_NAME, token, cookieOptions(env));
  return session;
}

/** Look up the session from the request cookie. Returns null when absent/invalid. */
export function getSessionFromRequest(c: Context, env: AppEnv): SessionRecord | null {
  const token = getCookie(c, env.SESSION_COOKIE_NAME);
  if (!token) return null;
  const session = findValidSession(hashSessionToken(token));
  if (session && session.lastSeenAt) {
    // Opportunistic touch, at most ~once per 15 minutes per session.
    const lastSeen = new Date(session.lastSeenAt).getTime();
    if (Date.now() - lastSeen > 15 * 60_000) touchSession(session.id);
  }
  return session;
}

/** Delete the server-side session (if any) and expire the cookie. */
export function revokeSession(c: Context, env: AppEnv): void {
  const token = getCookie(c, env.SESSION_COOKIE_NAME);
  if (token) deleteSessionByTokenHash(hashSessionToken(token));
  deleteCookie(c, env.SESSION_COOKIE_NAME, { path: '/' });
}
