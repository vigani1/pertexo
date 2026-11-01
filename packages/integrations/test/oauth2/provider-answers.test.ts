import { describe, expect, it } from 'vitest';

import { requestOAuth2Token } from '../../src/oauth2/token-endpoint.js';

const settings = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  authorizationParameters: {},
  pkce: 's256',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'client',
  scope: 'read',
  clientAuthentication: 'body',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
} as const;

type Answer = Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}>;

/** The provider is the outside service: what it answers is all this test sets. */
const ask = ({ status = 200, headers = {}, body }: Answer) =>
  requestOAuth2Token(
    {
      execute: () =>
        Promise.resolve({
          status,
          headers,
          body: new TextEncoder().encode(JSON.stringify(body)),
          bodyEncoding: 'utf8',
          finalUrl: 'https://id.example.com/token',
          redirectCount: 0,
        }),
    },
    settings,
    'client-secret',
    { grantType: 'refresh_token', refreshToken: 'held-refresh-token' },
  );

describe('provider-specific refusals', () => {
  // M5: Entra's and GitHub's names for a lost grant are not temporary failures.
  it.each([
    ['Entra', 400, 'interaction_required'],
    ['Entra', 400, 'consent_required'],
    ['GitHub', 200, 'bad_refresh_token'],
  ])(
    'M5 %s answering %i %s has lost the grant',
    async (_who, status, error) => {
      expect(await ask({ status, body: { error } })).toEqual({
        kind: 'grant_lost',
      });
    },
  );

  // M5: GitHub's name for a refused client is not a temporary failure.
  it('M5 GitHub answering incorrect_client_credentials refused the client', async () => {
    expect(
      await ask({ body: { error: 'incorrect_client_credentials' } }),
    ).toEqual({ kind: 'client_refused' });
  });

  // L10 stays: a name nobody has listed is temporary, so a typo can't drop a grant.
  it('keeps an unknown error temporary', async () => {
    expect(
      await ask({ status: 400, body: { error: 'stand_in' } }),
    ).toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('fields a service writes as null or empty', () => {
  // S4: a service that writes absent fields as null can still renew.
  it.each([
    ['refresh_token null', { refresh_token: null }],
    ['refresh_token empty', { refresh_token: '' }],
    ['token_type null', { token_type: null }],
  ])('S4 %s counts as absent', async (_name, fields) => {
    const answer = await ask({
      body: { access_token: 'new-access', expires_in: 3_600, ...fields },
    });
    expect(answer).toEqual({
      kind: 'issued',
      accessToken: 'new-access',
      expiresInSeconds: 3_600,
    });
  });

  it('still refuses a token_type that says something else', async () => {
    const answer = await ask({
      body: { access_token: 'new-access', token_type: 'mac' },
    });
    expect(answer).toMatchObject({ kind: 'invalid' });
  });
});

describe('how long a 429 blocks', () => {
  // S5: a Retry-After that can't be read takes the plan's 15 s default, not 1 s.
  it.each([
    ['an HTTP date', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    ['zero', '0'],
  ])('S5 %s blocks for the 15 s default', async (_name, retryAfter) => {
    const answer = await ask({
      status: 429,
      headers: { 'retry-after': retryAfter },
      body: {},
    });
    expect(answer).toEqual({ kind: 'rate_limited', retryAfterSeconds: 15 });
  });

  it('no header blocks for the 15 s default, and a number for that long', async () => {
    expect(await ask({ status: 429, body: {} })).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 15,
    });
    expect(
      await ask({ status: 429, headers: { 'retry-after': '7' }, body: {} }),
    ).toEqual({ kind: 'rate_limited', retryAfterSeconds: 7 });
  });
});
