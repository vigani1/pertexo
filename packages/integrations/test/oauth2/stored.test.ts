import { describe, expect, it } from 'vitest';

import type { SecureHttpResponse } from '../../src/http/secure.js';
import { ConnectionSecretEncryptionError } from '../../src/credentials/envelope-encryption.js';
import {
  decodeStoredClientSecret,
  decodeStoredTokens,
  encodeStoredClientSecret,
  encodeStoredTokens,
  isRenewable,
} from '../../src/oauth2/stored.js';
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

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function answering(body: unknown): {
  execute: () => Promise<SecureHttpResponse>;
} {
  return {
    execute: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify(body)),
        bodyEncoding: 'utf8',
        finalUrl: 'https://id.example.com',
        redirectCount: 0,
      }),
  };
}

describe('what an OAuth2 connection seals', () => {
  // S25: an id_token a service adds to its answer must never reach the sealed row.
  it('keeps no id_token from a real token answer', async () => {
    const answer = await requestOAuth2Token(
      answering({
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
        id_token: 'an.id.token',
        token_type: 'Bearer',
      }),
      settings,
      'client-secret',
      { grantType: 'refresh_token', refreshToken: 'held' },
    );
    if (answer.kind !== 'issued') throw new Error(`Answered ${answer.kind}`);
    const sealed = text(encodeStoredTokens(answer));
    expect(sealed).not.toContain('an.id.token');
    expect(JSON.parse(sealed)).toEqual({
      accessToken: 'the-access-token',
      refreshToken: 'the-refresh-token',
    });
  });

  // D1: both formats round trip, and nothing else can pass for them.
  it('reads back what it wrote, and refuses anything else', () => {
    const tokens = { accessToken: 'a', refreshToken: 'r' };
    expect(decodeStoredTokens(encodeStoredTokens(tokens))).toEqual(tokens);
    expect(
      decodeStoredTokens(encodeStoredTokens({ accessToken: 'a' })),
    ).toEqual({ accessToken: 'a' });
    expect(text(encodeStoredClientSecret('s'))).toBe(
      '{"type":"oauth2","clientSecret":"s"}',
    );
    expect(decodeStoredClientSecret(encodeStoredClientSecret('s'))).toBe('s');
    expect(() =>
      decodeStoredTokens(new TextEncoder().encode('{"accessToken":""}')),
    ).toThrow(ConnectionSecretEncryptionError);
    expect(() =>
      decodeStoredClientSecret(
        new TextEncoder().encode('{"type":"http_headers"}'),
      ),
    ).toThrow(ConnectionSecretEncryptionError);
  });

  // L5: client credentials renews with a new request; consent needs a refresh token.
  it('is renewable with a refresh token or a server-to-server client', () => {
    expect(isRenewable(settings, { accessToken: 'a' })).toBe(false);
    expect(isRenewable(settings, { accessToken: 'a', refreshToken: 'r' })).toBe(
      true,
    );
    expect(
      isRenewable(
        {
          grantType: 'client_credentials',
          tokenUrl: settings.tokenUrl,
          clientId: settings.clientId,
          scope: settings.scope,
          clientAuthentication: settings.clientAuthentication,
          tokenParameters: settings.tokenParameters,
          requestHosts: settings.requestHosts,
        },
        { accessToken: 'a' },
      ),
    ).toBe(true);
  });
});
