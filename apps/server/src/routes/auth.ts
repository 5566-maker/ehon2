import { Hono } from 'hono';
import { ErrorCodes, LoginRequestSchema } from '@ehon2/shared';
import type { Deps } from '../deps.js';
import { verifyPassword, verifyUsername } from '../auth/password.js';
import { getSessionFromRequest, issueSession, revokeSession } from '../auth/session.js';
import { fail, ok, zodDetails } from '../utils/response.js';
import { LoginLimiter, clientKeyFromRequest } from '../auth/loginLimiter.js';

/** Process-wide login rate limiter (5 failures / 5 min per client IP). */
const loginLimiter = new LoginLimiter();

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
    const passwordOk = verifyPassword(password, env.AUTH_PASSWORD_HASH);
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

  return app;
}
