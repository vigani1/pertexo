import type { ApiError } from '@/lib/api/error';

export class NativeAuthenticationError extends Error {
  public readonly status: number | undefined;
  public readonly code: string | undefined;
  public readonly kind: ApiError['kind'] | undefined;
  /** Bounded Retry-After from a rate-limited response. */
  public readonly retryAfterMs: number | undefined;

  public constructor(
    message: string,
    options: Readonly<{
      status?: number | undefined;
      code?: string | undefined;
      kind?: ApiError['kind'] | undefined;
      retryAfterMs?: number | undefined;
    }> = {},
  ) {
    super(message);
    this.name = 'NativeAuthenticationError';
    this.status = options.status;
    this.code = options.code;
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
  }
}
