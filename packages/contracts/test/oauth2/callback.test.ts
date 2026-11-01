import { describe, expect, it } from 'vitest';

import { API_PROBLEM_MANIFEST } from '../../src/errors/api-problem.js';
import {
  OAUTH2_CALLBACK_PATH,
  OAUTH2_LANDING_PATH,
  oauth2CallbackLandingSchema,
  oauth2CallbackQuerySchema,
  oauth2CallbackStateSchema,
  oauth2ConnectionErrorCodeSchema,
  oauth2StepFailureCodeSchema,
} from '../../src/schemas/oauth2-connections.js';

import { connectionFields } from './fixture.js';

const STATE = `${'A'.repeat(22)}.${'b'.repeat(43)}`;

describe('the callback query', () => {
  const parse = (query: Record<string, unknown>) =>
    oauth2CallbackQuerySchema.safeParse(query);

  // S1: 22 base64url characters, a dot, then 43.
  it.each([
    ['too short a workspace', `${'A'.repeat(21)}.${'b'.repeat(43)}`],
    ['too short a secret', `${'A'.repeat(22)}.${'b'.repeat(42)}`],
    ['no dot', `${'A'.repeat(22)}${'b'.repeat(43)}`],
    ['base64 padding', `${'A'.repeat(22)}.${'b'.repeat(42)}=`],
    ['a plus sign', `${'A'.repeat(21)}+.${'b'.repeat(43)}`],
  ])('S1 refuses a state with %s', (_name, state) => {
    expect(oauth2CallbackStateSchema.safeParse(state).success).toBe(false);
  });

  it('takes a code', () => {
    expect(parse({ state: STATE, code: 'the-code' }).data).toEqual({
      kind: 'code',
      state: STATE,
      code: 'the-code',
    });
  });

  it('takes an error, and drops the provider’s description (S9)', () => {
    expect(
      parse({
        state: STATE,
        error: 'access_denied',
        error_description: 'private words',
      }).data,
    ).toEqual({ kind: 'error', state: STATE, error: 'access_denied' });
  });

  it('keeps a provider’s own extra parameters from failing it', () => {
    expect(
      parse({ state: STATE, code: 'the-code', iss: 'https://id.example.com' })
        .success,
    ).toBe(true);
  });

  it('refuses a code and an error together', () => {
    expect(
      parse({ state: STATE, code: 'the-code', error: 'access_denied' }).success,
    ).toBe(false);
  });

  it('refuses neither a code nor an error', () => {
    expect(parse({ state: STATE }).success).toBe(false);
  });

  it('refuses no state', () => {
    expect(parse({ code: 'the-code' }).success).toBe(false);
  });

  it.each([
    ['state', { state: [STATE, STATE], code: 'the-code' }],
    ['code', { state: STATE, code: ['one', 'two'] }],
    ['error', { state: STATE, error: ['one', 'two'] }],
  ])('refuses a repeated %s', (_name, query) => {
    expect(parse(query).success).toBe(false);
  });

  it('bounds the code and the error', () => {
    expect(parse({ state: STATE, code: 'c'.repeat(4_096) }).success).toBe(true);
    expect(parse({ state: STATE, code: 'c'.repeat(4_097) }).success).toBe(
      false,
    );
    expect(parse({ state: STATE, error: 'e'.repeat(64) }).success).toBe(true);
    expect(parse({ state: STATE, error: 'e'.repeat(65) }).success).toBe(false);
  });

  it('a landing names a connection unless it is invalid (S7)', () => {
    const ids = {
      workspaceId: connectionFields.workspaceId,
      connectionId: connectionFields.id,
    };
    for (const result of [
      'connected',
      'denied',
      'token_refused',
      'provider_unavailable',
    ]) {
      expect(
        oauth2CallbackLandingSchema.safeParse({ result, ...ids }).success,
      ).toBe(true);
      expect(oauth2CallbackLandingSchema.safeParse({ result }).success).toBe(
        false,
      );
    }
    expect(
      oauth2CallbackLandingSchema.safeParse({ result: 'invalid' }).success,
    ).toBe(true);
    expect(
      oauth2CallbackLandingSchema.safeParse({ result: 'invalid', ...ids })
        .success,
    ).toBe(false);
  });
});

describe('the names the plan fixes', () => {
  it('uses the paths people register', () => {
    expect(OAUTH2_CALLBACK_PATH).toBe('/v1/connections/oauth2/callback');
    expect(OAUTH2_LANDING_PATH).toBe('/connections/oauth2/finished');
  });

  it('lists every connection failure', () => {
    expect(oauth2ConnectionErrorCodeSchema.options).toEqual([
      'connection.oauth2_not_authorized',
      'connection.oauth2_grant_revoked',
      'connection.oauth2_client_rejected',
      'connection.oauth2_token_expired',
    ]);
  });

  it('lists every step failure', () => {
    expect(oauth2StepFailureCodeSchema.options).toEqual([
      'http.oauth2_not_connected',
      'http.oauth2_connection_revoked',
      'http.oauth2_grant_revoked',
      'http.oauth2_client_rejected',
      'http.oauth2_token_expired',
      'http.oauth2_token_rate_limited',
      'http.oauth2_token_endpoint_unavailable',
      'http.oauth2_token_response_invalid',
      'http.oauth2_token_address_blocked',
      'http.oauth2_refresh_busy',
      'http.oauth2_host_not_allowed',
    ]);
  });

  it('gives the refused address 400 and the refused start 409', () => {
    expect(
      API_PROBLEM_MANIFEST['connection.oauth2_endpoint_refused'].status,
    ).toBe(400);
    expect(API_PROBLEM_MANIFEST['connection.oauth2_token_refused'].status).toBe(
      409,
    );
  });
});
