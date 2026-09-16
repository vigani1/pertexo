import type { ApiProblem } from '@pertexo/contracts/schemas/errors';

type ApiErrorKind = 'canceled' | 'network' | 'problem' | 'protocol' | 'timeout';

type ApiErrorOptions = Readonly<{
  kind: ApiErrorKind;
  message: string;
  status?: number | undefined;
  requestId?: string | undefined;
  retryAfterMs?: number | undefined;
  problem?: ApiProblem | undefined;
  problemDetails?: unknown;
  cause?: unknown;
}>;

export class ApiError extends Error {
  public readonly kind: ApiErrorKind;
  public readonly status: number | undefined;
  public readonly requestId: string | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly problem: ApiProblem | undefined;
  public readonly problemDetails: unknown;

  public constructor(options: ApiErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ApiError';
    this.kind = options.kind;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.problem = options.problem;
    this.problemDetails = options.problemDetails;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
