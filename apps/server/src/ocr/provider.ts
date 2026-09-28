import { ErrorCodes } from '@ehon2/shared';
import type { AppEnv } from '../env.js';
import { GoogleVisionOcrProvider } from './googleVision.js';
import type { OcrProvider } from './types.js';

/** Error raised by the OCR layer (mirrors AiError's shape). */
export class OcrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type OcrProviderName = 'google' | 'openai-legacy';

/** Resolve which OCR provider the deployment wants. */
export function resolveOcrProviderName(env: AppEnv): OcrProviderName {
  if (env.GOOGLE_VISION_ENABLED === false) return 'openai-legacy';
  return env.OCR_PROVIDER === 'openai-legacy' ? 'openai-legacy' : 'google';
}

/**
 * Build the OCR provider for page processing.
 * Throws OcrError with a helpful message when Google is selected but no
 * API key is configured (the server keeps starting so the user can fix
 * the environment without a broken deploy).
 */
export function createOcrProvider(env: AppEnv): OcrProvider {
  const name = resolveOcrProviderName(env);
  if (name === 'google') {
    if (!env.GOOGLE_VISION_API_KEY) {
      throw new OcrError(
        ErrorCodes.OCR_PROVIDER_FAILED,
        'OCR provider "google" is selected but GOOGLE_VISION_API_KEY is not set. ' +
          'Set it in the server environment (Zeabur variables), or set OCR_PROVIDER=openai-legacy.',
      );
    }
    return new GoogleVisionOcrProvider({ apiKey: env.GOOGLE_VISION_API_KEY });
  }
  throw new OcrError(
    ErrorCodes.INTERNAL_ERROR,
    'The legacy OpenAI OCR path is handled by AiService, not the OCR provider factory.',
  );
}
