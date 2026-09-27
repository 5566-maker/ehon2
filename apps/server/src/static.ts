import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deps } from './deps.js';

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
};

/**
 * Resolve the frontend build output directory.
 *
 * - Docker runtime: /app/deploy/public (next to /app/deploy/dist)
 * - Monorepo dev:   <repo>/apps/web/dist
 * - PUBLIC_DIR env overrides everything.
 */
export function resolvePublicDir(explicit?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    join(here, '..', 'public'), // deploy/dist -> deploy/public (Docker)
    join(here, '..', '..', 'web', 'dist'), // apps/server/{src,dist} -> apps/web/dist (dev)
  ].filter((c): c is string => !!c);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

export function serveStaticApp(deps: Deps): Hono {
  const app = new Hono();
  const publicDir = resolvePublicDir(deps.env.PUBLIC_DIR);

  if (!publicDir) {
    console.warn('[static] frontend build not found — serving API only');
    app.get('*', (c) =>
      c.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } },
        404,
      ),
    );
    return app;
  }

  const root = resolve(publicDir) + sep;
  console.log(`[static] serving frontend from ${publicDir}`);

  app.get('*', (c) => {
    const urlPath = new URL(c.req.url).pathname;
    // Never let the SPA fallback shadow /api (already handled, but be safe).
    if (urlPath.startsWith('/api/')) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    }
    const rel = urlPath.replace(/^\/+/, '');
    const abs = resolve(publicDir, rel);
    let file = abs.startsWith(root) && existsSync(abs) && statSync(abs).isFile() ? abs : null;
    // SPA fallback
    if (!file) file = join(publicDir, 'index.html');
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const data = readFileSync(file);
    const isIndex = file.endsWith('index.html');
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'Content-Length': String(data.byteLength),
        'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
      },
    });
  });

  return app;
}
