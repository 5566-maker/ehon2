/** Error raised by the AI layer. Carries a stable ErrorCodes code. */
export class AiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}
