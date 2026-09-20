export type LlmErrorKind =
  | 'cancelled'
  | 'network'
  | 'rate_limit'
  | 'credits'
  | 'auth'
  | 'model_unavailable'
  | 'invalid_request'
  | 'provider';

export class LlmRequestError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      kind: LlmErrorKind;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
    }
  ) {
    super(message);
    this.name = 'LlmRequestError';
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function normalizeLlmError(error: unknown): LlmRequestError {
  if (error instanceof LlmRequestError) return error;

  if (error instanceof Error && error.name === 'AbortError') {
    return new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
  }

  if (error instanceof TypeError) {
    return new LlmRequestError(error.message || 'Network request failed.', {
      kind: 'network',
      retryable: true
    });
  }

  if (error instanceof Error) {
    return new LlmRequestError(error.message, { kind: 'provider' });
  }

  return new LlmRequestError('Unknown provider error.', { kind: 'provider' });
}
