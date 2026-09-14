import { describe, expect, it } from 'vitest';

import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type HttpExecutionErrorKind,
  type HttpOutcomeDecision,
  type HttpSideEffectClass,
} from '../src/server.js';

const CLASSES = [
  'safe',
  'idempotent_with_key',
  'unsafe',
] as const satisfies readonly HttpSideEffectClass[];

function retryDecision(
  errorKind: HttpExecutionErrorKind,
  sideEffectClass: HttpSideEffectClass,
): HttpOutcomeDecision {
  return {
    kind: 'retry',
    errorKind,
    reuseProviderKey: sideEffectClass === 'idempotent_with_key',
  };
}

function definiteRetryDecision(
  errorKind: HttpExecutionErrorKind,
  sideEffectClass: HttpSideEffectClass,
): HttpOutcomeDecision {
  return sideEffectClass === 'unsafe'
    ? { kind: 'failed', errorKind }
    : retryDecision(errorKind, sideEffectClass);
}

function ambiguousDecision(
  errorKind: 'network' | 'provider' | 'timeout',
  sideEffectClass: HttpSideEffectClass,
): HttpOutcomeDecision {
  return sideEffectClass === 'unsafe'
    ? { kind: 'outcome_unknown', errorKind }
    : retryDecision(errorKind, sideEffectClass);
}

const RESPONSE_CASES = [
  {
    name: 'successful lower bound',
    status: 200,
    expected: () => ({ kind: 'succeeded' as const }),
  },
  {
    name: 'successful upper bound',
    status: 299,
    expected: () => ({ kind: 'succeeded' as const }),
  },
  {
    name: 'provider refusal',
    status: 400,
    expected: () => ({
      kind: 'failed' as const,
      errorKind: 'provider' as const,
    }),
  },
  {
    name: 'unauthorized',
    status: 401,
    expected: () => ({
      kind: 'failed' as const,
      errorKind: 'authentication' as const,
    }),
  },
  {
    name: 'forbidden',
    status: 403,
    expected: () => ({
      kind: 'failed' as const,
      errorKind: 'authentication' as const,
    }),
  },
  {
    name: 'request timeout',
    status: 408,
    expected: (sideEffectClass: HttpSideEffectClass) =>
      definiteRetryDecision('timeout', sideEffectClass),
  },
  {
    name: 'too early',
    status: 425,
    expected: (sideEffectClass: HttpSideEffectClass) =>
      definiteRetryDecision('timeout', sideEffectClass),
  },
  {
    name: 'rate limited',
    status: 429,
    expected: (sideEffectClass: HttpSideEffectClass) =>
      definiteRetryDecision('rate_limit', sideEffectClass),
  },
  {
    name: 'server failure lower bound',
    status: 500,
    expected: (sideEffectClass: HttpSideEffectClass) =>
      ambiguousDecision('provider', sideEffectClass),
  },
  {
    name: 'server failure upper bound',
    status: 599,
    expected: (sideEffectClass: HttpSideEffectClass) =>
      ambiguousDecision('provider', sideEffectClass),
  },
  {
    name: 'non-HTTP status',
    status: 600,
    expected: () => ({
      kind: 'failed' as const,
      errorKind: 'provider' as const,
    }),
  },
] as const;

function terminalErrorKind(
  code: (typeof SECURE_HTTP_ERROR_CODE)[keyof typeof SECURE_HTTP_ERROR_CODE],
): HttpExecutionErrorKind {
  if (
    code === SECURE_HTTP_ERROR_CODE.dnsFailed ||
    code === SECURE_HTTP_ERROR_CODE.networkFailed
  )
    return 'network';
  if (code === SECURE_HTTP_ERROR_CODE.timedOut) return 'timeout';
  if (code === SECURE_HTTP_ERROR_CODE.canceled) return 'canceled';
  if (code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed) return 'internal';
  return 'configuration';
}

function expectedErrorDecision(
  code: (typeof SECURE_HTTP_ERROR_CODE)[keyof typeof SECURE_HTTP_ERROR_CODE],
  classification: 'ambiguous' | 'definite_failure',
  possiblyDispatched: boolean,
  sideEffectClass: HttpSideEffectClass,
): HttpOutcomeDecision {
  if (code === SECURE_HTTP_ERROR_CODE.canceled)
    return sideEffectClass === 'unsafe' && possiblyDispatched
      ? { kind: 'outcome_unknown', errorKind: 'provider' }
      : { kind: 'canceled', errorKind: 'canceled' };
  if (classification === 'ambiguous')
    return ambiguousDecision(
      code === SECURE_HTTP_ERROR_CODE.timedOut ? 'timeout' : 'network',
      sideEffectClass,
    );
  if (code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed)
    return possiblyDispatched
      ? definiteRetryDecision('provider', sideEffectClass)
      : retryDecision('provider', sideEffectClass);
  if (code === SECURE_HTTP_ERROR_CODE.dnsFailed)
    return possiblyDispatched
      ? definiteRetryDecision('network', sideEffectClass)
      : retryDecision('network', sideEffectClass);
  if (
    code === SECURE_HTTP_ERROR_CODE.networkFailed ||
    code === SECURE_HTTP_ERROR_CODE.timedOut
  )
    return possiblyDispatched
      ? definiteRetryDecision(terminalErrorKind(code), sideEffectClass)
      : retryDecision(terminalErrorKind(code), sideEffectClass);
  return { kind: 'failed', errorKind: terminalErrorKind(code) };
}

describe('ADR 007 HTTP outcome policy', () => {
  it.each(CLASSES)('accepts 2xx truth for %s operations', (sideEffectClass) => {
    expect(
      classifySecureHttpResponse(
        204,
        sideEffectClass,
        sideEffectClass === 'idempotent_with_key',
      ),
    ).toEqual({ kind: 'succeeded' });
  });

  it('retries safe and keyed work but preserves the same provider key', () => {
    expect(classifySecureHttpResponse(503, 'safe', false)).toEqual({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: false,
    });
    expect(
      classifySecureHttpResponse(503, 'idempotent_with_key', true),
    ).toEqual({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: true,
    });
    expect(
      classifySecureHttpError(
        new SecureHttpError('network_failed', 'ambiguous', true),
        'idempotent_with_key',
        true,
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'network',
      reuseProviderKey: true,
    });
  });

  it('makes unsafe ambiguous transport and provider outcomes explicitly unknown', () => {
    expect(classifySecureHttpResponse(500, 'unsafe', false)).toEqual({
      kind: 'outcome_unknown',
      errorKind: 'provider',
    });
    expect(
      classifySecureHttpError(
        new SecureHttpError('timed_out', 'ambiguous', true),
        'unsafe',
        false,
      ),
    ).toEqual({ kind: 'outcome_unknown', errorKind: 'timeout' });
    expect(
      classifySecureHttpError(
        new SecureHttpError('canceled', 'definite_failure', true),
        'unsafe',
        false,
      ),
    ).toEqual({ kind: 'outcome_unknown', errorKind: 'provider' });
  });

  it('does not retry definite unsafe failures or accept a missing provider key', () => {
    expect(classifySecureHttpResponse(429, 'unsafe', false)).toEqual({
      kind: 'failed',
      errorKind: 'rate_limit',
    });
    expect(
      classifySecureHttpResponse(503, 'idempotent_with_key', false),
    ).toEqual({ kind: 'failed', errorKind: 'configuration' });
    expect(
      classifySecureHttpError(
        new SecureHttpError('network_failed', 'definite_failure', false),
        'idempotent_with_key',
        false,
      ),
    ).toEqual({ kind: 'failed', errorKind: 'configuration' });
    expect(
      classifySecureHttpError(
        new SecureHttpError('response_too_large', 'definite_failure', true),
        'unsafe',
        false,
      ),
    ).toEqual({ kind: 'failed', errorKind: 'configuration' });
  });

  it('maps a pre-dispatch provider-runtime outage into the immutable retry policy', () => {
    expect(
      classifySecureHttpError(
        new SecureHttpError(
          'dispatch_evidence_failed',
          'definite_failure',
          false,
        ),
        'unsafe',
        false,
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: false,
    });
  });

  it('keeps auth, cancellation, and pre-dispatch DNS truth distinct', () => {
    expect(classifySecureHttpResponse(401, 'safe', false)).toEqual({
      kind: 'failed',
      errorKind: 'authentication',
    });
    expect(
      classifySecureHttpError(
        new SecureHttpError('canceled', 'definite_failure', false),
        'safe',
        false,
      ),
    ).toEqual({ kind: 'canceled', errorKind: 'canceled' });
    expect(
      classifySecureHttpError(
        new SecureHttpError('dns_failed', 'definite_failure', false),
        'safe',
        false,
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'network',
      reuseProviderKey: false,
    });
    expect(
      classifySecureHttpError(
        new SecureHttpError('dns_failed', 'definite_failure', false),
        'unsafe',
        false,
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'network',
      reuseProviderKey: false,
    });
  });

  it('uses only the closed stable secure HTTP error vocabulary', () => {
    expect(Object.values(SECURE_HTTP_ERROR_CODE)).toContain(
      'response_encoding_rejected',
    );
  });

  it('classifies every admitted response family exactly for every side-effect policy', () => {
    for (const { name, status, expected } of RESPONSE_CASES)
      for (const sideEffectClass of CLASSES) {
        const decision = classifySecureHttpResponse(
          status,
          sideEffectClass,
          sideEffectClass === 'idempotent_with_key',
        );
        expect({ name, sideEffectClass, decision }).toEqual({
          name,
          sideEffectClass,
          decision: expected(sideEffectClass),
        });
      }
  });

  it('classifies every secure-client error state exactly without widening the vocabulary', () => {
    for (const code of Object.values(SECURE_HTTP_ERROR_CODE))
      for (const sideEffectClass of CLASSES)
        for (const [classification, possiblyDispatched] of [
          ['definite_failure', false],
          ['definite_failure', true],
          ['ambiguous', false],
          ['ambiguous', true],
        ] as const) {
          const decision = classifySecureHttpError(
            new SecureHttpError(code, classification, possiblyDispatched),
            sideEffectClass,
            sideEffectClass === 'idempotent_with_key',
          );
          expect({
            code,
            sideEffectClass,
            classification,
            possiblyDispatched,
            decision,
          }).toEqual({
            code,
            sideEffectClass,
            classification,
            possiblyDispatched,
            decision: expectedErrorDecision(
              code,
              classification,
              possiblyDispatched,
              sideEffectClass,
            ),
          });
        }
  });
});
