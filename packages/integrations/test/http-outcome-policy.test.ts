import { describe, expect, it } from 'vitest';

import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type HttpSideEffectClass,
} from '../src/server.js';

const CLASSES = [
  'safe',
  'idempotent_with_key',
  'unsafe',
] as const satisfies readonly HttpSideEffectClass[];

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
        new SecureHttpError('response_too_large', 'definite_failure', true),
        'unsafe',
        false,
      ),
    ).toEqual({ kind: 'failed', errorKind: 'configuration' });
  });

  it('retries a pre-dispatch evidence outage without pretending it is a provider failure', () => {
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
      errorKind: 'internal',
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

  it('classifies every admitted response family for every side-effect policy', () => {
    for (const status of [
      200, 299, 400, 401, 403, 408, 425, 429, 500, 599, 600,
    ])
      for (const sideEffectClass of CLASSES) {
        const decision = classifySecureHttpResponse(
          status,
          sideEffectClass,
          sideEffectClass === 'idempotent_with_key',
        );
        expect(['succeeded', 'failed', 'retry', 'outcome_unknown']).toContain(
          decision.kind,
        );
      }
  });

  it('classifies every secure-client error code without widening the vocabulary', () => {
    for (const code of Object.values(SECURE_HTTP_ERROR_CODE))
      for (const sideEffectClass of CLASSES)
        for (const [classification, possiblyDispatched] of [
          ['definite_failure', false],
          ['definite_failure', true],
          ['ambiguous', true],
        ] as const) {
          const decision = classifySecureHttpError(
            new SecureHttpError(code, classification, possiblyDispatched),
            sideEffectClass,
            sideEffectClass === 'idempotent_with_key',
          );
          expect(['failed', 'retry', 'canceled', 'outcome_unknown']).toContain(
            decision.kind,
          );
        }
  });
});
