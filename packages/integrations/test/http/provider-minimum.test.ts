import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  classifySecureHttpResponse,
  HttpRequestExecutorError,
  SlackSendMessageExecutorError,
} from '../../src/server.js';
import { providerFailure } from '../../src/providers/failure.js';
import { HttpOAuth2Failure } from '../../src/http-request/execution/oauth2-failure.js';
import { OAuth2TokenFailure } from '../../src/oauth2/oauth2-token.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());
it('does not schedule an HTTP retry before its advertised HTTP-date', () => {
  expect(
    classifySecureHttpResponse(429, 'safe', {
      providerKeyPresent: false,
      headers: { 'retry-after': 'Tue, 01 Jan 2030 00:00:30 GMT' },
    }),
  ).toMatchObject({ kind: 'retry', minimumRetryDelayMillis: 30_000 });
});
it.each(['safe', 'idempotent_with_key'] as const)(
  'stops %s HTTP work when the service minimum exceeds the supported automatic wait',
  (sideEffectClass) => {
    const error = new HttpRequestExecutorError(
      classifySecureHttpResponse(429, sideEffectClass, {
        providerKeyPresent: sideEffectClass === 'idempotent_with_key',
        headers: { 'retry-after': '300' },
      }),
      { possiblyDispatched: false },
    );
    expect(error).toMatchObject({
      kind: 'failed',
      errorKind: 'rate_limit',
      safeErrorCode: 'provider.retry_after_exceeded',
    });
    expect(error.minimumRetryDelayMillis).toBeUndefined();
    expect(error.shownSummary).toMatch(/service.*wait longer/iu);
  },
);
it('does not shorten a provider adapter minimum into an earlier automatic retry', () => {
  const error = providerFailure(SlackSendMessageExecutorError)(
    'retry',
    'rate_limit',
    { possiblyDispatched: false, retryAfterMillis: 300_000 },
  );
  expect(error).toMatchObject({
    kind: 'failed',
    errorKind: 'rate_limit',
    safeErrorCode: 'provider.retry_after_exceeded',
  });
  expect(error.minimumRetryDelayMillis).toBeUndefined();
});
it('keeps a long OAuth token-address block out of the shorter attempt retry contract', () => {
  const error = new HttpOAuth2Failure(
    new OAuth2TokenFailure('http.oauth2_token_rate_limited', 300),
  );
  expect(error).toMatchObject({
    kind: 'failed',
    errorKind: 'rate_limit',
    safeErrorCode: 'provider.retry_after_exceeded',
  });
  expect(error.minimumRetryDelayMillis).toBeUndefined();
});
