import { errorCodeIs, errorNameIs, safeInstanceOf } from './unknown-error.js';

export const SECURE_HTTP_ERROR_CODE = Object.freeze({
  canceled: 'canceled',
  connectionFenceFailed: 'connection_fence_failed',
  dispatchBindingMismatch: 'dispatch_binding_mismatch',
  dispatchEvidenceFailed: 'dispatch_evidence_failed',
  dnsFailed: 'dns_failed',
  invalidRequest: 'invalid_request',
  networkFailed: 'network_failed',
  paginationOriginChanged: 'pagination_origin_changed',
  paginationNavigationInvalid: 'pagination_navigation_invalid',
  redirectRejected: 'redirect_rejected',
  responseEncodingRejected: 'response_encoding_rejected',
  responseTooLarge: 'response_too_large',
  ssrfBlocked: 'ssrf_blocked',
  timedOut: 'timed_out',
} as const);

export type SecureHttpErrorCode =
  (typeof SECURE_HTTP_ERROR_CODE)[keyof typeof SECURE_HTTP_ERROR_CODE];

export class SecureHttpError extends Error {
  public readonly possiblyDispatched: boolean;
  public override readonly name = 'SecureHttpError';

  public constructor(
    public readonly code: SecureHttpErrorCode,
    public readonly classification: 'ambiguous' | 'definite_failure',
    { possiblyDispatched }: Readonly<{ possiblyDispatched: boolean }>,
  ) {
    super(`Secure HTTP request failed: ${code}`);
    this.possiblyDispatched = possiblyDispatched;
  }
}

export type SecureHttpErrorDetails = Readonly<{
  classification: SecureHttpError['classification'];
  code: SecureHttpErrorCode;
  error: SecureHttpError;
  possiblyDispatched: boolean;
}>;

const SECURE_HTTP_ERROR_CODES = new Set<unknown>(
  Object.values(SECURE_HTTP_ERROR_CODE),
);

export function inspectSecureHttpError(
  error: unknown,
): SecureHttpErrorDetails | undefined {
  if (!safeInstanceOf(error, SecureHttpError)) return undefined;
  try {
    const code: unknown = error.code;
    const classification: unknown = error.classification;
    const possiblyDispatched: unknown = error.possiblyDispatched;
    const invalidErrorDetails =
      !SECURE_HTTP_ERROR_CODES.has(code) ||
      (classification !== 'ambiguous' &&
        classification !== 'definite_failure') ||
      typeof possiblyDispatched !== 'boolean';
    if (invalidErrorDetails) return undefined;
    return Object.freeze({
      classification,
      code: code as SecureHttpErrorCode,
      error,
      possiblyDispatched,
    });
  } catch {
    return undefined;
  }
}

export function isTimeoutError(error: unknown): boolean {
  return (
    safeInstanceOf(error, Error) &&
    (errorCodeIs(error, 'ETIMEDOUT') || errorNameIs(error, 'TimeoutError'))
  );
}

export function failure(
  code: SecureHttpErrorCode,
  {
    possiblyDispatched,
    ambiguous,
    cause: _cause,
  }: Readonly<{
    possiblyDispatched: boolean;
    ambiguous: boolean;
    cause?: unknown;
  }>,
): SecureHttpError {
  return new SecureHttpError(
    code,
    ambiguous ? 'ambiguous' : 'definite_failure',
    { possiblyDispatched },
  );
}

export function abortFailure(
  signal: AbortSignal,
  {
    possiblyDispatched,
    ambiguous,
  }: Readonly<{ possiblyDispatched: boolean; ambiguous: boolean }>,
): SecureHttpError {
  const timedOut = errorNameIs(signal.reason, 'TimeoutError');
  return failure(
    timedOut
      ? SECURE_HTTP_ERROR_CODE.timedOut
      : SECURE_HTTP_ERROR_CODE.canceled,
    { possiblyDispatched, ambiguous },
  );
}
