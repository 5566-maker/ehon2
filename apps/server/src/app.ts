import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { Deps } from './deps.js';
import { requireAuth } from './middleware/requireAuth.js';
import { authRoutes } from './routes/auth.js';
import { booksRoutes } from './routes/books.js';
import { pagesRoutes } from './routes/pages.js';
import { blocksRoutes } from './routes/blocks.js';
import { audioRoutes } from './routes/audio.js';
import { ok } from './utils/response.js';
import { serveStaticApp } from './static.js';

export function createApp(deps: Deps): Hono {
  const { env } = deps;
  const app = new Hono();

  app.use(logger());

  app.get('/api/health', (c) =>
    ok(c, { status: 'ok', name: env.APP_NAME, time: new Date().toISOString() }),
  );

  // Public auth endpoints.
  app.route('/api/auth', authRoutes(deps));

  // Everything else under /api requires a session.
  app.use('/api/*', requireAuth(env));
  app.route('/api/books', booksRoutes(deps));
  app.route('/api/pages', pagesRoutes(deps));
  app.route('/api/text-blocks', blocksRoutes(deps));
  app.route('/api/audio', audioRoutes(deps));

  // Frontend static files + SPA fallback (everything else).
  app.route('/', serveStaticApp(deps));

  return app;
}
