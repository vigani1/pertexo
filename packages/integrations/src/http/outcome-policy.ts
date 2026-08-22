import { SECURE_HTTP_ERROR_CODE, type SecureHttpError } from './secure-http.js';

export const HTTP_SIDE_EFFECT_CLASS = Object.freeze({
  idempotentWithKey: 'idempotent_with_key',
  safe: 'safe',
  unsafe: 'unsafe',
} as const);

export type HttpSideEffectClass =
  (typeof HTTP_SIDE_EFFECT_CLASS)[keyof typeof HTTP_SIDE_EFFECT_CLASS];

export type HttpExecutionErrorKind =
  | 'authentication'
  | 'canceled'
  | 'configuration'
  | 'internal'
  | 'network'
  | 'provider'
  | 'rate_limit'
  | 'timeout';

export type HttpOutcomeDecision =
  | Readonly<{ kind: 'succeeded' }>
  | Readonly<{ kind: 'failed'; errorKind: HttpExecutionErrorKind }>
  | Readonly<{ kind: 'canceled'; errorKind: 'canceled' }>
  | Readonly<{
      kind: 'retry';
      errorKind: HttpExecutionErrorKind;
      reuseProviderKey: boolean;
    }>
  | Readonly<{
      kind: 'outcome_unknown';
      errorKind: 'network' | 'provider' | 'timeout';
    }>;

export function classifySecureHttpResponse(
  status: number,
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): HttpOutcomeDecision {
  if (!validPolicy(sideEffectClass, providerKeyPresent))
    return failed('configuration');
  if (status >= 200 && status <= 299)
    return Object.freeze({ kind: 'succeeded' });
  if (status === 401 || status === 403) return failed('authentication');
  if (status === 429)
    return retryDefinite('rate_limit', sideEffectClass, providerKeyPresent);
  if ([408, 425].includes(status))
    return retryDefinite('timeout', sideEffectClass, providerKeyPresent);
  if (status >= 500 && status <= 599)
    return retryAmbiguousProvider(sideEffectClass, providerKeyPresent);
  return failed('provider');
}

export function classifySecureHttpError(
  error: SecureHttpError,
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): HttpOutcomeDecision {
  if (!validPolicy(sideEffectClass, providerKeyPresent))
    return failed('configuration');
  if (error.code === SECURE_HTTP_ERROR_CODE.canceled)
    return Object.freeze({ kind: 'canceled', errorKind: 'canceled' });
  const errorKind = secureErrorKind(error);
  if (error.classification === 'ambiguous')
    return retryOrUnknown(
      errorKind === 'timeout' ? 'timeout' : 'network',
      sideEffectClass,
      providerKeyPresent,
    );
  if (
    error.code === SECURE_HTTP_ERROR_CODE.dnsFailed ||
    error.code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed
  )
    return error.possiblyDispatched
      ? retryDefinite(errorKind, sideEffectClass, providerKeyPresent)
      : retry(errorKind, sideEffectClass, providerKeyPresent);
  if (
    !error.possiblyDispatched &&
    (error.code === SECURE_HTTP_ERROR_CODE.networkFailed ||
      error.code === SECURE_HTTP_ERROR_CODE.timedOut)
  )
    return retry(errorKind, sideEffectClass, providerKeyPresent);
  if (
    (error.code === SECURE_HTTP_ERROR_CODE.networkFailed ||
      error.code === SECURE_HTTP_ERROR_CODE.timedOut) &&
    error.possiblyDispatched
  )
    return retryDefinite(errorKind, sideEffectClass, providerKeyPresent);
  return failed(errorKind);
}

function validPolicy(
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): boolean {
  return sideEffectClass !== 'idempotent_with_key' || providerKeyPresent;
}

function retryDefinite(
  errorKind: HttpExecutionErrorKind,
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): HttpOutcomeDecision {
  if (sideEffectClass === 'unsafe') return failed(errorKind);
  return retry(errorKind, sideEffectClass, providerKeyPresent);
}

function retryAmbiguousProvider(
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): HttpOutcomeDecision {
  if (sideEffectClass === 'unsafe')
    return Object.freeze({
      kind: 'outcome_unknown',
      errorKind: 'provider',
    });
  return retry('provider', sideEffectClass, providerKeyPresent);
}

function retryOrUnknown(
  errorKind: 'network' | 'timeout',
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): HttpOutcomeDecision {
  if (sideEffectClass === 'unsafe')
    return Object.freeze({ kind: 'outcome_unknown', errorKind });
  return retry(errorKind, sideEffectClass, providerKeyPresent);
}

function retry(
  errorKind: HttpExecutionErrorKind,
  sideEffectClass: HttpSideEffectClass,
  providerKeyPresent: boolean,
): HttpOutcomeDecision {
  return Object.freeze({
    kind: 'retry',
    errorKind,
    reuseProviderKey:
      sideEffectClass === 'idempotent_with_key' && providerKeyPresent,
  });
}

function failed(errorKind: HttpExecutionErrorKind): HttpOutcomeDecision {
  return Object.freeze({ kind: 'failed', errorKind });
}

function secureErrorKind(error: SecureHttpError): HttpExecutionErrorKind {
  switch (error.code) {
    case SECURE_HTTP_ERROR_CODE.canceled:
      return 'canceled';
    case SECURE_HTTP_ERROR_CODE.dnsFailed:
    case SECURE_HTTP_ERROR_CODE.networkFailed:
      return 'network';
    case SECURE_HTTP_ERROR_CODE.timedOut:
      return 'timeout';
    case SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed:
      return 'internal';
    case SECURE_HTTP_ERROR_CODE.invalidRequest:
    case SECURE_HTTP_ERROR_CODE.redirectRejected:
    case SECURE_HTTP_ERROR_CODE.responseEncodingRejected:
    case SECURE_HTTP_ERROR_CODE.responseTooLarge:
    case SECURE_HTTP_ERROR_CODE.ssrfBlocked:
      return 'configuration';
    default:
      return unreachable(error.code);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unreachable secure HTTP error code: ${String(value)}`);
}
