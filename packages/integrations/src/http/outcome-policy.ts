import { MAXIMUM_RETRY_DELAY_MILLIS } from '@pertexo/node-sdk/server';

import { parseBoundedRetryAfterMillis } from './retry-after.js';

import {
  PROVIDER_HTTP_ERROR_CODE,
  type ProviderHttpError,
} from '../providers/http.errors.js';

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
      minimumRetryDelayMillis?: number;
    }>
  | Readonly<{
      kind: 'outcome_unknown';
      errorKind: 'network' | 'provider' | 'timeout';
    }>;

export function classifySecureHttpResponse(
  status: number,
  sideEffectClass: HttpSideEffectClass,
  {
    providerKeyPresent,
    headers = {},
  }: Readonly<{
    providerKeyPresent: boolean;
    headers?: Readonly<Record<string, string>> | undefined;
  }>,
): HttpOutcomeDecision {
  if (!validPolicy(sideEffectClass, { providerKeyPresent }))
    return failed('configuration');
  if (status >= 200 && status <= 299)
    return Object.freeze({ kind: 'succeeded' });
  if (status === 401 || status === 403) return failed('authentication');
  if (status === 429) {
    const decision = retryDefinite('rate_limit', sideEffectClass, {
      providerKeyPresent,
    });
    return decision.kind === 'retry'
      ? Object.freeze({
          ...decision,
          minimumRetryDelayMillis: parseBoundedRetryAfterMillis(
            headers['retry-after'],
            MAXIMUM_RETRY_DELAY_MILLIS,
          ),
        })
      : decision;
  }
  if ([408, 425].includes(status))
    return retryDefinite('timeout', sideEffectClass, {
      providerKeyPresent,
    });
  if (status >= 500 && status <= 599)
    return retryAmbiguousProvider(sideEffectClass, {
      providerKeyPresent,
    });
  return failed('provider');
}

const unreadableResponseCodes = new Set<ProviderHttpError['code']>([
  PROVIDER_HTTP_ERROR_CODE.responseTooLarge,
  PROVIDER_HTTP_ERROR_CODE.responseEncodingRejected,
  PROVIDER_HTTP_ERROR_CODE.responseRedactionLimit,
]);

export function classifySecureHttpError(
  error: Pick<
    ProviderHttpError,
    'code' | 'classification' | 'possiblyDispatched'
  >,
  sideEffectClass: HttpSideEffectClass,
  { providerKeyPresent }: Readonly<{ providerKeyPresent: boolean }>,
): HttpOutcomeDecision {
  if (!validPolicy(sideEffectClass, { providerKeyPresent }))
    return failed('configuration');
  if (error.code === PROVIDER_HTTP_ERROR_CODE.canceled)
    return sideEffectClass === 'unsafe' && error.possiblyDispatched
      ? Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' })
      : Object.freeze({ kind: 'canceled', errorKind: 'canceled' });
  // A local response refusal cannot establish whether a dispatched effect happened.
  if (
    sideEffectClass === 'unsafe' &&
    error.possiblyDispatched &&
    unreadableResponseCodes.has(error.code)
  )
    return Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' });
  const errorKind = secureErrorKind(error);
  if (error.classification === 'ambiguous')
    return retryOrUnknown(
      errorKind === 'timeout' ? 'timeout' : 'network',
      sideEffectClass,
      { providerKeyPresent },
    );
  if (error.code === PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed)
    return error.possiblyDispatched
      ? retryDefinite('provider', sideEffectClass, {
          providerKeyPresent,
        })
      : retry('provider', sideEffectClass, {
          providerKeyPresent,
        });
  if (error.code === PROVIDER_HTTP_ERROR_CODE.dnsFailed)
    return error.possiblyDispatched
      ? retryDefinite(errorKind, sideEffectClass, {
          providerKeyPresent,
        })
      : retry(errorKind, sideEffectClass, {
          providerKeyPresent,
        });
  if (
    !error.possiblyDispatched &&
    (error.code === PROVIDER_HTTP_ERROR_CODE.networkFailed ||
      error.code === PROVIDER_HTTP_ERROR_CODE.timedOut)
  )
    return retry(errorKind, sideEffectClass, {
      providerKeyPresent,
    });
  if (
    (error.code === PROVIDER_HTTP_ERROR_CODE.networkFailed ||
      error.code === PROVIDER_HTTP_ERROR_CODE.timedOut) &&
    error.possiblyDispatched
  )
    return retryDefinite(errorKind, sideEffectClass, {
      providerKeyPresent,
    });
  return failed(errorKind);
}

function validPolicy(
  sideEffectClass: HttpSideEffectClass,
  { providerKeyPresent }: Readonly<{ providerKeyPresent: boolean }>,
): boolean {
  return sideEffectClass !== 'idempotent_with_key' || providerKeyPresent;
}

function retryDefinite(
  errorKind: HttpExecutionErrorKind,
  sideEffectClass: HttpSideEffectClass,
  { providerKeyPresent }: Readonly<{ providerKeyPresent: boolean }>,
): HttpOutcomeDecision {
  if (sideEffectClass === 'unsafe') return failed(errorKind);
  return retry(errorKind, sideEffectClass, {
    providerKeyPresent,
  });
}

function retryAmbiguousProvider(
  sideEffectClass: HttpSideEffectClass,
  { providerKeyPresent }: Readonly<{ providerKeyPresent: boolean }>,
): HttpOutcomeDecision {
  if (sideEffectClass === 'unsafe')
    return Object.freeze({
      kind: 'outcome_unknown',
      errorKind: 'provider',
    });
  return retry('provider', sideEffectClass, {
    providerKeyPresent,
  });
}

function retryOrUnknown(
  errorKind: 'network' | 'timeout',
  sideEffectClass: HttpSideEffectClass,
  { providerKeyPresent }: Readonly<{ providerKeyPresent: boolean }>,
): HttpOutcomeDecision {
  if (sideEffectClass === 'unsafe')
    return Object.freeze({ kind: 'outcome_unknown', errorKind });
  return retry(errorKind, sideEffectClass, {
    providerKeyPresent,
  });
}

function retry(
  errorKind: HttpExecutionErrorKind,
  sideEffectClass: HttpSideEffectClass,
  { providerKeyPresent }: Readonly<{ providerKeyPresent: boolean }>,
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

function secureErrorKind(
  error: Pick<
    ProviderHttpError,
    'code' | 'classification' | 'possiblyDispatched'
  >,
): HttpExecutionErrorKind {
  switch (error.code) {
    case PROVIDER_HTTP_ERROR_CODE.canceled:
      return 'canceled';
    case PROVIDER_HTTP_ERROR_CODE.dnsFailed:
    case PROVIDER_HTTP_ERROR_CODE.networkFailed:
      return 'network';
    case PROVIDER_HTTP_ERROR_CODE.timedOut:
      return 'timeout';
    case PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed:
      return 'internal';
    case PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed:
    case PROVIDER_HTTP_ERROR_CODE.dispatchBindingMismatch:
    case PROVIDER_HTTP_ERROR_CODE.invalidRequest:
    case PROVIDER_HTTP_ERROR_CODE.paginationOriginChanged:
    case PROVIDER_HTTP_ERROR_CODE.paginationNavigationInvalid:
    case PROVIDER_HTTP_ERROR_CODE.redirectRejected:
    case PROVIDER_HTTP_ERROR_CODE.responseRedactionLimit:
    case PROVIDER_HTTP_ERROR_CODE.responseEncodingRejected:
    case PROVIDER_HTTP_ERROR_CODE.responseTooLarge:
    case PROVIDER_HTTP_ERROR_CODE.ssrfBlocked:
      return 'configuration';
    default:
      return unreachable(error.code);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unreachable secure HTTP error code: ${String(value)}`);
}
