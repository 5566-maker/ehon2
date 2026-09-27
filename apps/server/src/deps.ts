import type { AppEnv } from './env.js';
import type { FileStorage } from './storage/files.js';
import type { AiService } from './openai/service.js';

export interface Deps {
  env: AppEnv;
  storage: FileStorage;
  ai: AiService;
}
