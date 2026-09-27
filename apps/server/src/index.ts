import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { loadEnv } from './env.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { FileStorage } from './storage/files.js';
import { AiService } from './openai/service.js';
import { createApp } from './app.js';
import type { Deps } from './deps.js';

const env = loadEnv();

const dbPath = join(env.DATA_DIR, 'ehon2.db');
const db = openDatabase(dbPath);
runMigrations(db, env.MIGRATIONS_DIR);

const purged = purgeExpiredSessions(db);
if (purged > 0) console.log(`[auth] purged ${purged} expired session(s)`);

const deps: Deps = {
  env,
  storage: new FileStorage(env.DATA_DIR),
  ai: new AiService(env),
};

const app = createApp(deps);

console.log(`[ehon2] ${env.APP_NAME} listening on port ${env.PORT} (DATA_DIR=${env.DATA_DIR})`);
serve({ fetch: app.fetch, port: env.PORT });
