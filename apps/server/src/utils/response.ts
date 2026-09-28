import type { Context } from 'hono';
import type { ApiErrorBody, ApiSuccess } from '@ehon2/shared';

/** Success envelope: { success: true, data }. */
export function ok<T>(c: Context, data: T, status = 200) {
  const body: ApiSuccess<T> = { success: true, data };
  return c.json(body, status as 200);
}

/** Error envelope: { success: false, error: { code, message, details? } }. */
export function fail(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiErrorBody = { success: false, error: { code, message, details } };
  return c.json(body, status);
}

/** Map a Zod parse failure to INVALID_REQUEST without leaking internals. */
export function zodDetails(error: { issues: { path: (string | number)[]; message: string }[] }) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}
