import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  encodeStoredClientSecret,
  newOAuth2State,
  type SecureHttpResponse,
} from '@pertexo/integrations/server';

import { FinishOAuth2AuthorizationUseCase } from '../../../src/connections/oauth2/finish-authorization.js';
import type {
  ConnectionOAuth2Dependencies,
  ConnectionSecretEncryptionPort,
} from '../../../src/connections/ports.js';

const SETTINGS = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  authorizationParameters: {},
  pkce: 'none',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'client',
  scope: 'read',
  clientAuthentication: 'body',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
} as const;

/**
 * The key service and token address are the outside services. Persistence is the
 * port the database implements; a real one is in the worker's consent suite, which
 * has no way to make a key service fail once.
 */
function callback(sealFailures: number) {
  const workspaceId = randomUUID();
  const connectionId = randomUUID();
  let failuresLeft = sealFailures;
  const authorized: string[] = [];
  const encryption = {
    open: () =>
      Promise.resolve(Uint8Array.from(encodeStoredClientSecret('secret'))),
    seal: () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Promise.reject(new Error('key service blipped'));
      }
      return Promise.resolve({ ciphertext: 'sealed' });
    },
  } as unknown as ConnectionSecretEncryptionPort;
  const answer: SecureHttpResponse = {
    status: 200,
    headers: {},
    body: new TextEncoder().encode(
      JSON.stringify({ access_token: 'issued', refresh_token: 'refresh' }),
    ),
    bodyEncoding: 'utf8',
    finalUrl: SETTINGS.tokenUrl,
    redirectCount: 0,
  };
  const dependencies = {
    endpointPolicy: { publicWebOrigin: 'https://pertexo.example.com' },
    tokenClient: { execute: () => Promise.resolve(answer) },
    persistence: {
      consumeOAuth2Authorization: () =>
        Promise.resolve({
          kind: 'consumed',
          connectionId,
          settings: SETTINGS,
          clientSecret: { ciphertext: 'client' },
          secretVersionId: randomUUID(),
          startedBy: randomUUID(),
        }),
      authorizeOAuth2Connection: ({
        connectionId: id,
      }: {
        connectionId: string;
      }) => {
        authorized.push(id);
        return Promise.resolve({ id });
      },
    },
  } as unknown as ConnectionOAuth2Dependencies;
  const finish = new FinishOAuth2AuthorizationUseCase(
    dependencies,
    encryption,
    'application-secret-of-enough-length-for-this-test',
  );
  return {
    connectionId,
    authorized,
    run: () =>
      finish.execute({
        query: { code: 'the-code', state: newOAuth2State(workspaceId) },
        cookieHeader: undefined,
      }),
  };
}

const resultOf = (location: string): string | null =>
  new URL(location).searchParams.get('result');

describe('a callback meeting a key service fault', () => {
  it('a healthy key service connects', async () => {
    const { connectionId, authorized, run } = callback(0);
    expect(resultOf((await run()).location)).toBe('connected');
    expect(authorized).toEqual([connectionId]);
  });

  // S2: the code is already spent, so a blip here would lose the first tokens.
  it('S2 a seal that fails once still connects', async () => {
    const { connectionId, authorized, run } = callback(1);
    expect(resultOf((await run()).location)).toBe('connected');
    expect(authorized).toEqual([connectionId]);
  });
});
