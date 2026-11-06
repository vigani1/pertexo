import { describe, expect, it } from 'vitest';

import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  PROVIDER_HTTP_ERROR_CODE,
  ProviderHttpError,
} from '../../src/server.js';
import {
  CLASSES,
  ERROR_CASES,
  RESPONSE_CASES,
  expectedFor,
} from './outcome-cases.js';

describe('ADR 007 HTTP outcome policy', () => {
  it.each(CLASSES)('accepts 2xx truth for %s operations', (sideEffectClass) => {
    expect(
      classifySecureHttpResponse(204, sideEffectClass, {
        providerKeyPresent: sideEffectClass === 'idempotent_with_key',
      }),
    ).toEqual({ kind: 'succeeded' });
  });

  it('retries safe and keyed work but preserves the same provider key', () => {
    expect(
      classifySecureHttpResponse(503, 'safe', { providerKeyPresent: false }),
    ).toEqual({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: false,
    });
    expect(
      classifySecureHttpResponse(503, 'idempotent_with_key', {
        providerKeyPresent: true,
      }),
    ).toEqual({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: true,
    });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('network_failed', 'ambiguous', {
          possiblyDispatched: true,
        }),
        'idempotent_with_key',
        { providerKeyPresent: true },
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'network',
      reuseProviderKey: true,
    });
  });

  it('makes unsafe ambiguous transport and provider outcomes explicitly unknown', () => {
    expect(
      classifySecureHttpResponse(500, 'unsafe', { providerKeyPresent: false }),
    ).toEqual({
      kind: 'outcome_unknown',
      errorKind: 'provider',
    });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('timed_out', 'ambiguous', {
          possiblyDispatched: true,
        }),
        'unsafe',
        { providerKeyPresent: false },
      ),
    ).toEqual({ kind: 'outcome_unknown', errorKind: 'timeout' });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('canceled', 'definite_failure', {
          possiblyDispatched: true,
        }),
        'unsafe',
        { providerKeyPresent: false },
      ),
    ).toEqual({ kind: 'outcome_unknown', errorKind: 'provider' });
  });

  it('does not retry definite unsafe failures or accept a missing provider key', () => {
    expect(
      classifySecureHttpResponse(429, 'unsafe', { providerKeyPresent: false }),
    ).toEqual({
      kind: 'failed',
      errorKind: 'rate_limit',
    });
    expect(
      classifySecureHttpResponse(503, 'idempotent_with_key', {
        providerKeyPresent: false,
      }),
    ).toEqual({ kind: 'failed', errorKind: 'configuration' });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('network_failed', 'definite_failure', {
          possiblyDispatched: false,
        }),
        'idempotent_with_key',
        { providerKeyPresent: false },
      ),
    ).toEqual({ kind: 'failed', errorKind: 'configuration' });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('response_too_large', 'definite_failure', {
          possiblyDispatched: true,
        }),
        'unsafe',
        { providerKeyPresent: false },
      ),
    ).toEqual({ kind: 'outcome_unknown', errorKind: 'provider' });
  });

  it('maps a pre-dispatch provider-runtime outage into the immutable retry policy', () => {
    expect(
      classifySecureHttpError(
        new ProviderHttpError('dispatch_evidence_failed', 'definite_failure', {
          possiblyDispatched: false,
        }),
        'unsafe',
        { providerKeyPresent: false },
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: false,
    });
  });

  it('keeps auth, cancellation, and pre-dispatch DNS truth distinct', () => {
    expect(
      classifySecureHttpResponse(401, 'safe', { providerKeyPresent: false }),
    ).toEqual({
      kind: 'failed',
      errorKind: 'authentication',
    });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('canceled', 'definite_failure', {
          possiblyDispatched: false,
        }),
        'safe',
        { providerKeyPresent: false },
      ),
    ).toEqual({ kind: 'canceled', errorKind: 'canceled' });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('dns_failed', 'definite_failure', {
          possiblyDispatched: false,
        }),
        'safe',
        { providerKeyPresent: false },
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'network',
      reuseProviderKey: false,
    });
    expect(
      classifySecureHttpError(
        new ProviderHttpError('dns_failed', 'definite_failure', {
          possiblyDispatched: false,
        }),
        'unsafe',
        { providerKeyPresent: false },
      ),
    ).toEqual({
      kind: 'retry',
      errorKind: 'network',
      reuseProviderKey: false,
    });
  });

  it('uses only the closed stable secure HTTP error vocabulary', () => {
    expect(Object.values(PROVIDER_HTTP_ERROR_CODE)).toContain(
      'response_encoding_rejected',
    );
  });

  it.each(RESPONSE_CASES)(
    'classifies HTTP status %i for every side-effect class',
    (status, ...row) => {
      for (const sideEffectClass of CLASSES)
        expect({
          sideEffectClass,
          decision: classifySecureHttpResponse(status, sideEffectClass, {
            providerKeyPresent: sideEffectClass === 'idempotent_with_key',
          }),
        }).toEqual({
          sideEffectClass,
          decision: expectedFor(row, sideEffectClass),
        });
    },
  );

  it('has a decision for every secure-client error code', () => {
    expect(new Set(ERROR_CASES.map(([code]) => code))).toEqual(
      new Set(Object.values(PROVIDER_HTTP_ERROR_CODE)),
    );
    expect(ERROR_CASES).toHaveLength(
      Object.values(PROVIDER_HTTP_ERROR_CODE).length * 4,
    );
  });

  it.each(ERROR_CASES)(
    'classifies %s (%s, possibly dispatched: %s) for every side-effect class',
    (code, classification, possiblyDispatched, ...row) => {
      for (const sideEffectClass of CLASSES)
        expect({
          sideEffectClass,
          decision: classifySecureHttpError(
            new ProviderHttpError(code, classification, { possiblyDispatched }),
            sideEffectClass,
            { providerKeyPresent: sideEffectClass === 'idempotent_with_key' },
          ),
        }).toEqual({
          sideEffectClass,
          decision: expectedFor(row, sideEffectClass),
        });
    },
  );
});
