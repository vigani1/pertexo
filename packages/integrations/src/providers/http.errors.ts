import { safeInstanceOf } from '@pertexo/node-sdk/server';

export const PROVIDER_HTTP_ERROR_CODE = Object.freeze({
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
  responseRedactionLimit: 'response_redaction_limit',
  responseTooLarge: 'response_too_large',
  ssrfBlocked: 'ssrf_blocked',
  timedOut: 'timed_out',
} as const);

export type ProviderHttpErrorCode =
  (typeof PROVIDER_HTTP_ERROR_CODE)[keyof typeof PROVIDER_HTTP_ERROR_CODE];

export class ProviderHttpError extends Error {
  public readonly possiblyDispatched: boolean;
  public override readonly name = 'ProviderHttpError';

  public constructor(
    public readonly code: ProviderHttpErrorCode,
    public readonly classification: 'ambiguous' | 'definite_failure',
    { possiblyDispatched }: Readonly<{ possiblyDispatched: boolean }>,
  ) {
    super(`Secure HTTP request failed: ${code}`);
    this.possiblyDispatched = possiblyDispatched;
  }
}

export type ProviderHttpErrorDetails = Readonly<{
  classification: ProviderHttpError['classification'];
  code: ProviderHttpErrorCode;
  error: ProviderHttpError;
  possiblyDispatched: boolean;
}>;

const PROVIDER_HTTP_ERROR_CODES = new Set<unknown>(
  Object.values(PROVIDER_HTTP_ERROR_CODE),
);

export function inspectProviderHttpError(
  error: unknown,
): ProviderHttpErrorDetails | undefined {
  if (!safeInstanceOf(error, ProviderHttpError)) return undefined;
  try {
    const code: unknown = error.code;
    const classification: unknown = error.classification;
    const possiblyDispatched: unknown = error.possiblyDispatched;
    const invalidErrorDetails =
      !PROVIDER_HTTP_ERROR_CODES.has(code) ||
      (classification !== 'ambiguous' &&
        classification !== 'definite_failure') ||
      typeof possiblyDispatched !== 'boolean';
    if (invalidErrorDetails) return undefined;
    return Object.freeze({
      classification,
      code: code as ProviderHttpErrorCode,
      error,
      possiblyDispatched,
    });
  } catch {
    return undefined;
  }
}

export function providerHttpPreDispatchError(
  code: ProviderHttpErrorCode,
): ProviderHttpError {
  return new ProviderHttpError(code, 'definite_failure', {
    possiblyDispatched: false,
  });
}
