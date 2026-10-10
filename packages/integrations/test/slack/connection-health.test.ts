import { describe, expect, it } from 'vitest';

import {
  classifySlackConnectionHealth,
  createSlackClient,
} from '../../src/server.js';

describe('Slack connection health evidence (ADR059)', () => {
  it.each([
    [
      200,
      '{"ok":false,"error":"token_revoked","token":"must-not-retain"}',
      {
        kind: 'reauthorization_required',
        reasonCode: 'connection.slack_token_revoked',
      },
    ],
    [401, '{"ok":false,"error":"token_revoked"}', undefined],
    [403, '{"ok":false,"error":"account_inactive"}', undefined],
    [200, '{"ok":false,"error":"invalid_auth"}', undefined],
    [200, '{"ok":"false","error":"token_expired"}', undefined],
    [200, '{"error":"token_revoked"}', undefined],
  ] as const)(
    'requires parsed provider evidence rather than HTTP status %#',
    async (status, payload, expected) => {
      const body = new TextEncoder().encode(payload);
      const client = createSlackClient({
        execute: (request) =>
          Promise.resolve({
            status,
            headers: {},
            body,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          }),
      });
      const result = await client.authTest({
        botToken: 'xoxb-owned-fixture',
        timeoutMillis: 1_000,
        beforeDispatch: () => Promise.resolve(),
      });
      expect(classifySlackConnectionHealth(result)).toEqual(expected);
      expect(body.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([
    ['account_inactive', 'connection.slack_account_inactive'],
    ['token_expired', 'connection.slack_token_expired'],
    ['token_revoked', 'connection.slack_token_revoked'],
  ] as const)('maps only the definitive %s rejection', (error, reasonCode) => {
    const observation = classifySlackConnectionHealth({
      kind: 'rejected',
      error,
    });
    expect(observation).toEqual({
      kind: 'reauthorization_required',
      reasonCode,
    });
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it('accepts a validated successful response without retaining response data', () => {
    expect(classifySlackConnectionHealth({ kind: 'succeeded' })).toEqual({
      kind: 'healthy',
    });
  });

  it.each([
    'invalid_auth',
    'not_authed',
    'missing_scope',
    'channel_not_found',
    'no_permission',
    'not_in_channel',
    'is_archived',
    'service_unavailable',
    'team_disabled',
    'TOKEN_REVOKED',
    'token_revoked extra',
  ])('does not infer rejection from %s', (error) => {
    expect(
      classifySlackConnectionHealth({ kind: 'rejected', error }),
    ).toBeUndefined();
  });

  it.each([
    { kind: 'http_failure', status: 401 },
    { kind: 'http_failure', status: 403 },
    { kind: 'http_failure', status: 500 },
    { kind: 'rate_limited', retryAfterMillis: 1_000 },
    { kind: 'invalid_response' },
  ] as const)('does not infer health from $kind', (result) => {
    expect(classifySlackConnectionHealth(result)).toBeUndefined();
  });
});
