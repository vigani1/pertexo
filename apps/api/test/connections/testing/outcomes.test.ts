import { describe, expect, it } from 'vitest';
import {
  resendTestOutcome,
  responseOutcome,
  slackTestOutcome,
} from '../../../src/connections/testing/outcomes.js';

const rejected = (httpStatus: number | null, errorCode: string) => ({
  ok: false,
  httpStatus,
  errorCode,
  reauthorizationRequired: false,
});
const reauthorize = (httpStatus: number, errorCode: string) => ({
  ok: false,
  httpStatus,
  errorCode,
  reauthorizationRequired: true,
});

describe('what a connection test records for each provider answer', () => {
  it.each([
    [200, { ok: true, httpStatus: 200 }],
    [299, { ok: true, httpStatus: 299 }],
    [400, rejected(400, 'connection.provider_rejected')],
    [401, reauthorize(401, 'connection.credential_rejected')],
    [403, reauthorize(403, 'connection.credential_rejected')],
    [429, rejected(429, 'connection.provider_rate_limited')],
    [500, rejected(500, 'connection.provider_unavailable')],
  ] as const)('records HTTP status %i', (status, expected) => {
    expect(responseOutcome(status)).toEqual(expected);
  });

  it.each([
    ['success', { kind: 'succeeded' }, { ok: true, httpStatus: 200 }],
    [
      'account inactive',
      { kind: 'rejected', error: 'account_inactive' },
      reauthorize(200, 'connection.slack_account_inactive'),
    ],
    [
      'invalid auth',
      { kind: 'rejected', error: 'invalid_auth' },
      rejected(200, 'connection.provider_rejected'),
    ],
    [
      'not authed',
      { kind: 'rejected', error: 'not_authed' },
      rejected(200, 'connection.provider_rejected'),
    ],
    [
      'token revoked',
      { kind: 'rejected', error: 'token_revoked' },
      reauthorize(200, 'connection.slack_token_revoked'),
    ],
    [
      'token expired',
      { kind: 'rejected', error: 'token_expired' },
      reauthorize(200, 'connection.slack_token_expired'),
    ],
    [
      'generic unauthorized',
      { kind: 'http_failure', status: 401 },
      rejected(401, 'connection.provider_rejected'),
    ],
    [
      'generic forbidden',
      { kind: 'http_failure', status: 403 },
      rejected(403, 'connection.provider_rejected'),
    ],
    [
      'HTTP throttle',
      { kind: 'http_failure', status: 429 },
      rejected(429, 'connection.provider_rate_limited'),
    ],
    [
      'other rejection',
      { kind: 'rejected', error: 'team_disabled' },
      rejected(200, 'connection.provider_rejected'),
    ],
  ] as const)('records the Slack %s answer', (_name, result, expected) => {
    expect(slackTestOutcome(result)).toEqual(expected);
  });

  it.each([
    [
      'success',
      { kind: 'succeeded', emailId: 'email-id' },
      { ok: true, httpStatus: 200 },
    ],
    [
      'credential rejection',
      { kind: 'rejected', status: 401, error: 'invalid_api_key' },
      reauthorize(401, 'connection.credential_rejected'),
    ],
    [
      'provider rejection',
      { kind: 'rejected', status: 400, error: 'invalid_request' },
      rejected(400, 'connection.provider_rejected'),
    ],
    [
      'rate limit',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
      rejected(429, 'connection.provider_rate_limited'),
    ],
    [
      'invalid response',
      { kind: 'invalid_response' },
      rejected(null, 'connection.provider_invalid_response'),
    ],
  ] as const)('records the Resend %s answer', (_name, result, expected) => {
    expect(resendTestOutcome(result)).toEqual(expected);
  });
});
