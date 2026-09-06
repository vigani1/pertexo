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

export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (('code' in error && error.code === 'ETIMEDOUT') ||
      error.name === 'TimeoutError')
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
  const timedOut =
    signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return failure(
    timedOut
      ? SECURE_HTTP_ERROR_CODE.timedOut
      : SECURE_HTTP_ERROR_CODE.canceled,
    possiblyDispatched,
    ambiguous,
  );
}
