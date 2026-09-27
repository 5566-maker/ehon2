import type { Context, Next } from 'hono';
import { ErrorCodes } from '@ehon2/shared';
import type { AppEnv } from '../env.js';
import { getSessionFromRequest } from '../auth/session.js';
import { fail } from '../utils/response.js';

export interface AuthContext {
  authenticated: true;
}

/**
 * Protects API routes. Public routes (health, login, session-check, logout)
 * are registered before this middleware is applied.
 */
export function requireAuth(env: AppEnv) {
  return async (c: Context, next: Next) => {
    const session = getSessionFromRequest(c, env);
    if (!session) {
      return fail(c, 401, ErrorCodes.UNAUTHENTICATED, 'Authentication required.');
    }
    c.set('session', session);
    await next();
  };
}
