import { Hono } from 'hono';
import {
  AUTH_PASSWORD_HASH_SETTING_KEY,
  ChangePasswordSchema,
  ErrorCodes,
  LoginRequestSchema,
} from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { hashPassword, verifyPassword, verifyUsername } from '../auth/password.js';
import { getSessionFromRequest, issueSession, revokeSession } from '../auth/session.js';
import { getSetting, setSetting } from '../db/settings.js';
import { deleteAllSessions } from '../db/sessions.js';
import { fail, ok, zodDetails } from '../utils/response.js';
import { LoginLimiter, clientKeyFromRequest } from '../auth/loginLimiter.js';

/** Process-wide login rate limiter (5 failures / 5 min per client IP). */
const loginLimiter = new LoginLimiter();

/**
 * Resolve the effective password hash: the settings-page override wins,
 * falling back to the environment variable when no override has been saved.
 */
function currentPasswordHash(env: Deps['env']): string {
  return getSetting(AUTH_PASSWORD_HASH_SETTING_KEY) ?? env.AUTH_PASSWORD_HASH;
}

export function authRoutes(deps: Deps): Hono {
  const { env } = deps;
  const app = new Hono();

  app.post('/login', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid login request.', zodDetails(parsed.error));
    }
    const clientKey = clientKeyFromRequest(c);
    if (loginLimiter.isBlocked(clientKey)) {
      return fail(c, 429, ErrorCodes.RATE_LIMITED, 'Too many failed login attempts. Please try again later.');
    }
    const { username, password } = parsed.data;
    const usernameOk = verifyUsername(username, env.AUTH_USERNAME);
    const passwordOk = verifyPassword(password, currentPasswordHash(env));
    if (!usernameOk || !passwordOk) {
      // Same response either way — do not reveal which field was wrong.
      loginLimiter.recordFailure(clientKey);
      return fail(c, 401, ErrorCodes.INVALID_CREDENTIALS, 'Invalid username or password.');
    }
    loginLimiter.recordSuccess(clientKey);
    issueSession(c, env);
    return ok(c, { authenticated: true });
  });

  app.post('/logout', (c) => {
    revokeSession(c, env);
    return ok(c, { authenticated: false });
  });

  app.get('/session', (c) => {
    const session = getSessionFromRequest(c, env);
    if (!session) {
      return fail(c, 401, ErrorCodes.UNAUTHENTICATED, 'Authentication required.');
    }
    return ok(c, { authenticated: true });
  });

  /**
   * Change the login password. Requires an active session.
   * The new hash is stored in the settings table (overriding AUTH_PASSWORD_HASH),
   * and every session is revoked so all clients must log in again.
   */
  app.post('/change-password', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid JSON body.');
    }
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      // Password values are never echoed in logs or error details.
      return fail(c, 400, ErrorCodes.INVALID_REQUEST, 'Invalid password change request.', zodDetails(parsed.error));
    }
    const clientKey = clientKeyFromRequest(c);
    // Shares the login rate limiter: wrong current-password guesses count
    // against the same per-client failure budget as /login attempts.
    if (loginLimiter.isBlocked(clientKey)) {
      return fail(c, 429, ErrorCodes.RATE_LIMITED, 'Too many failed attempts. Please try again later.');
    }
    const session = getSessionFromRequest(c, env);
    if (!session) {
      return fail(c, 401, ErrorCodes.UNAUTHENTICATED, 'Authentication required.');
    }
    const { currentPassword, newPassword } = parsed.data;
    if (!verifyPassword(currentPassword, currentPasswordHash(env))) {
      loginLimiter.recordFailure(clientKey);
      return fail(c, 401, ErrorCodes.INVALID_CREDENTIALS, 'Current password is incorrect.');
    }
    setSetting(AUTH_PASSWORD_HASH_SETTING_KEY, hashPassword(newPassword));
    deleteAllSessions();
    revokeSession(c, env);
    loginLimiter.recordSuccess(clientKey);
    return ok(c, { changed: true });
  });

  return app;
}
