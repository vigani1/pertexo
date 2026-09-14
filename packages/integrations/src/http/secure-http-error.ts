import { errorCodeIs, errorNameIs, safeInstanceOf } from './unknown-error.js';

export const SECURE_HTTP_ERROR_CODE = Object.freeze({
  canceled: 'canceled',
  connectionFenceFailed: 'connection_fence_failed',
  dispatchBindingMismatch: 'dispatch_binding_mismatch',
  dispatchEvidenceFailed: 'dispatch_evidence_failed',
  dnsFailed: 'dns_failed',
  invalidRequest: 'invalid_request',
  networkFailed: 'network_failed',
  redirectRejected: 'redirect_rejected',
  responseEncodingRejected: 'response_encoding_rejected',
  responseTooLarge: 'response_too_large',
  ssrfBlocked: 'ssrf_blocked',
  timedOut: 'timed_out',
} as const);

export type SecureHttpErrorCode =
  (typeof SECURE_HTTP_ERROR_CODE)[keyof typeof SECURE_HTTP_ERROR_CODE];

export class SecureHttpError extends Error {
  public override readonly name = 'SecureHttpError';

  public constructor(
    public readonly code: SecureHttpErrorCode,
    public readonly classification: 'ambiguous' | 'definite_failure',
    public readonly possiblyDispatched: boolean,
  ) {
    super(`Secure HTTP request failed: ${code}`);
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
    if (
      !SECURE_HTTP_ERROR_CODES.has(code) ||
      (classification !== 'ambiguous' &&
        classification !== 'definite_failure') ||
      typeof possiblyDispatched !== 'boolean'
    )
      return undefined;
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
  possiblyDispatched: boolean,
  ambiguous: boolean,
  cause?: unknown,
): SecureHttpError {
  void cause;
  return new SecureHttpError(
    code,
    ambiguous ? 'ambiguous' : 'definite_failure',
    possiblyDispatched,
  );
}

export function abortFailure(
  signal: AbortSignal,
  possiblyDispatched: boolean,
  ambiguous: boolean,
): SecureHttpError {
  const timedOut = errorNameIs(signal.reason, 'TimeoutError');
  return failure(
    timedOut
      ? SECURE_HTTP_ERROR_CODE.timedOut
      : SECURE_HTTP_ERROR_CODE.canceled,
    possiblyDispatched,
    ambiguous,
  );
}
