import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_PASSWORD_HASH_SETTING_KEY, ErrorCodes } from '@ehon2/shared';
import { hashPassword } from '../auth/password.js';
import { openDatabase, closeDatabase, getDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { deleteSetting, getSetting } from '../db/settings.js';
import { authRoutes } from './auth.js';

/**
 * Route-level tests for authRoutes: /change-password and the
 * settings-table password-hash override of /login.
 *
 * Each test uses a distinct x-forwarded-for client key so the shared
 * LoginLimiter state does not leak between tests.
 */

const COOKIE_NAME = 'ehon2_session';

function testEnv(password: string) {
  return {
    AUTH_USERNAME: 'testuser',
    AUTH_PASSWORD_HASH: hashPassword(password),
    SESSION_COOKIE_NAME: COOKIE_NAME,
    SESSION_TTL_HOURS: 720,
    COOKIE_SECURE: false,
    NODE_ENV: 'development',
    TTS_PROVIDER: 'kokoro',
  } as never;
}

function stubDeps(env: Record<string, unknown>) {
  return { env: env as never, storage: {} as never, ai: {} as never };
}

function sessionCookieValue(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const pair = setCookie.split(';')[0];
  if (!pair || !pair.startsWith(`${COOKIE_NAME}=`)) return null;
  return pair;
}

function jsonHeaders(clientKey: string, cookie?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': clientKey,
  };
  if (cookie) headers['cookie'] = cookie;
  return headers;
}

async function login(
  app: ReturnType<typeof authRoutes>,
  password: string,
  clientKey: string,
): Promise<{ status: number; cookie: string | null }> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: jsonHeaders(clientKey),
    body: JSON.stringify({ username: 'testuser', password }),
  });
  return { status: res.status, cookie: sessionCookieValue(res) };
}

async function changePassword(
  app: ReturnType<typeof authRoutes>,
  body: Record<string, string>,
  clientKey: string,
  cookie?: string | null,
) {
  return app.request('/change-password', {
    method: 'POST',
    headers: jsonHeaders(clientKey, cookie),
    body: JSON.stringify(body),
  });
}

describe('POST /auth/change-password', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ehon2-auth-routes-'));
    const db = openDatabase(join(dir, 'test.db'));
    runMigrations(db, join(process.cwd(), '..', '..', 'migrations'));
  });

  after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    deleteSetting(AUTH_PASSWORD_HASH_SETTING_KEY, getDatabase());
  });

  it('succeeds with the current password: new password works, old stops working', async () => {
    const oldPassword = 'old-pass-001';
    const newPassword = 'brand-new-002';
    const app = authRoutes(stubDeps(testEnv(oldPassword)));

    const { status, cookie } = await login(app, oldPassword, 'change-ok');
    assert.equal(status, 200);
    assert.ok(cookie, 'login should set a session cookie');

    const res = await changePassword(
      app,
      { currentPassword: oldPassword, newPassword, confirmPassword: newPassword },
      'change-ok',
      cookie,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; data: { changed: boolean } };
    assert.equal(body.success, true);
    assert.equal(body.data.changed, true);

    // The override hash was persisted to the settings table.
    const stored = getSetting(AUTH_PASSWORD_HASH_SETTING_KEY, getDatabase());
    assert.ok(stored && stored.startsWith('scrypt$'), 'settings hash should be a scrypt hash');
    assert.notEqual(stored, 'old-pass-001');

    // All sessions were revoked: the pre-change cookie is now dead.
    const sessionCheck = await app.request('/session', { headers: jsonHeaders('change-ok', cookie) });
    assert.equal(sessionCheck.status, 401);

    // Old password no longer logs in; new password does (via the settings override).
    const oldLogin = await login(app, oldPassword, 'change-ok-after');
    assert.equal(oldLogin.status, 401);
    const newLogin = await login(app, newPassword, 'change-ok-after');
    assert.equal(newLogin.status, 200);
    assert.ok(newLogin.cookie);
    const newSession = await app.request('/session', {
      headers: jsonHeaders('change-ok-after', newLogin.cookie),
    });
    assert.equal(newSession.status, 200);
  });

  it('rejects a wrong current password with 401 and keeps the old password', async () => {
    const app = authRoutes(stubDeps(testEnv('correct-003')));
    const { cookie } = await login(app, 'correct-003', 'change-wrong');
    assert.ok(cookie);

    const res = await changePassword(
      app,
      { currentPassword: 'nope-not-it', newPassword: 'new-pass-004', confirmPassword: 'new-pass-004' },
      'change-wrong',
      cookie,
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    assert.equal(body.success, false);
    assert.equal(body.error.code, ErrorCodes.INVALID_CREDENTIALS);
    assert.ok(!JSON.stringify(body).includes('nope-not-it'), 'password must not be echoed');

    // Password unchanged: old still works, "new" does not.
    assert.equal((await login(app, 'correct-003', 'change-wrong-check')).status, 200);
    assert.equal((await login(app, 'new-pass-004', 'change-wrong-check')).status, 401);
    assert.equal(getSetting(AUTH_PASSWORD_HASH_SETTING_KEY, getDatabase()), null);
  });

  it('rejects a new password shorter than 8 characters with 400', async () => {
    const app = authRoutes(stubDeps(testEnv('correct-005')));
    const { cookie } = await login(app, 'correct-005', 'change-short');
    const res = await changePassword(
      app,
      { currentPassword: 'correct-005', newPassword: 'short', confirmPassword: 'short' },
      'change-short',
      cookie,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.success, false);
    assert.equal(body.error.code, ErrorCodes.INVALID_REQUEST);
    assert.equal(getSetting(AUTH_PASSWORD_HASH_SETTING_KEY, getDatabase()), null);
  });

  it('rejects mismatched new passwords with 400', async () => {
    const app = authRoutes(stubDeps(testEnv('correct-006')));
    const { cookie } = await login(app, 'correct-006', 'change-mismatch');
    const res = await changePassword(
      app,
      { currentPassword: 'correct-006', newPassword: 'new-pass-007', confirmPassword: 'different-007' },
      'change-mismatch',
      cookie,
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.error.code, ErrorCodes.INVALID_REQUEST);
    assert.equal(getSetting(AUTH_PASSWORD_HASH_SETTING_KEY, getDatabase()), null);
  });

  it('requires an authenticated session (401 without cookie)', async () => {
    const app = authRoutes(stubDeps(testEnv('correct-008')));
    const res = await changePassword(
      app,
      { currentPassword: 'correct-008', newPassword: 'new-pass-009', confirmPassword: 'new-pass-009' },
      'change-nosession',
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    assert.equal(body.error.code, ErrorCodes.UNAUTHENTICATED);
    assert.equal(getSetting(AUTH_PASSWORD_HASH_SETTING_KEY, getDatabase()), null);
  });

  it('shares the login rate limiter: wrong current passwords block /login', async () => {
    const app = authRoutes(stubDeps(testEnv('shared-pass-010')));
    const { cookie } = await login(app, 'shared-pass-010', 'change-limiter');
    assert.ok(cookie);
    // 5 failed current-password guesses: normal 401s, then the client is blocked.
    for (let i = 0; i < 5; i++) {
      const res = await changePassword(
        app,
        { currentPassword: 'wrong', newPassword: 'new-pass-011', confirmPassword: 'new-pass-011' },
        'change-limiter',
        cookie,
      );
      assert.equal(res.status, 401, `attempt ${i + 1} should be 401`);
    }
    const sixth = await changePassword(
      app,
      { currentPassword: 'wrong', newPassword: 'new-pass-011', confirmPassword: 'new-pass-011' },
      'change-limiter',
      cookie,
    );
    assert.equal(sixth.status, 429);
    const err = (await sixth.json()) as { error: { code: string } };
    assert.equal(err.error.code, ErrorCodes.RATE_LIMITED);
    // The shared limiter also blocks /login for this client, even with correct credentials.
    const blockedLogin = await login(app, 'shared-pass-010', 'change-limiter');
    assert.equal(blockedLogin.status, 429);
  });

  it('login falls back to AUTH_PASSWORD_HASH when the settings override is absent', async () => {
    const app = authRoutes(stubDeps(testEnv('env-only-012')));
    const { status, cookie } = await login(app, 'env-only-012', 'change-fallback');
    assert.equal(status, 200);
    assert.ok(cookie);
    assert.equal((await login(app, 'wrong-pass', 'change-fallback')).status, 401);
  });
});
