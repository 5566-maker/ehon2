import type { ApiResponse } from '@ehon2/shared';

/**
 * Typed fetch layer. All requests send cookies (same-origin in production,
 * proxied in dev). Responses follow the { success, data } / { success, error }
 * envelope; errors throw ApiError with the server's stable error code.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'UNAUTHENTICATED';
  }
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('INTERNAL_ERROR', `Request failed (HTTP ${res.status}).`, res.status);
  }
  if (body.success) return body.data;
  throw new ApiError(body.error.code, body.error.message, res.status, body.error.details);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  return parseEnvelope<T>(res);
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseEnvelope<T>(res);
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'include', body: form });
  return parseEnvelope<T>(res);
}

/** Friendly message for an unknown error (never leaks internals). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  // Plain Errors thrown by client code (e.g. the HEIC conversion helper) carry
  // user-facing messages — surface them instead of swallowing.
  if (err instanceof Error && err.message) return err.message;
  return '请求失败，请稍后重试。';
}
