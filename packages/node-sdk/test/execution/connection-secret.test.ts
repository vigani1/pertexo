import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  withProviderCredential,
  type ProviderCredentialRefusal,
  type ResolvedProviderConnection,
} from '../../src/execution/connection-secret.js';

const schema = z.object({ token: z.string() }).strict();
const expected = {
  connectionId: 'connection-1',
  providerKey: 'slack',
  authTypes: ['slack_bot_token'],
  schema,
  refuse: (reason: ProviderCredentialRefusal) => new Error(`refused:${reason}`),
} as const;

function resolved(
  secretText: string,
  overrides: Partial<ResolvedProviderConnection> = {},
): ResolvedProviderConnection {
  return {
    connectionId: 'connection-1',
    providerKey: 'slack',
    authType: 'slack_bot_token',
    secretVersionId: 'version-1',
    secret: new TextEncoder().encode(secretText),
    ...overrides,
  };
}

const zeroed = (secret: Uint8Array) => secret.every((byte) => byte === 0);

describe('a provider step opening its credential', () => {
  it('hands the parsed credential to the work, then zeroes the secret', async () => {
    const connection = resolved('{"token":"xoxb-1"}');
    await expect(
      withProviderCredential(connection, expected, (credential) =>
        Promise.resolve(credential.token),
      ),
    ).resolves.toBe('xoxb-1');
    expect(zeroed(connection.secret)).toBe(true);
  });

  it('zeroes the secret when the work fails', async () => {
    const connection = resolved('{"token":"xoxb-1"}');
    await expect(
      withProviderCredential(connection, expected, () =>
        Promise.reject(new Error('provider down')),
      ),
    ).rejects.toThrow('provider down');
    expect(zeroed(connection.secret)).toBe(true);
  });

  it.each([
    ['another connection', { connectionId: 'connection-2' }],
    ['another provider', { providerKey: 'email' }],
    ['another kind of credential', { authType: 'smtp' }],
  ] as const)(
    'refuses %s as configuration, without running the work, and zeroes the secret',
    async (_case, overrides) => {
      const connection = resolved('{"token":"xoxb-1"}', overrides);
      let ran = false;
      await expect(
        withProviderCredential(connection, expected, () => {
          ran = true;
          return Promise.resolve();
        }),
      ).rejects.toThrow('refused:configuration');
      expect(ran).toBe(false);
      expect(zeroed(connection.secret)).toBe(true);
    },
  );

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON the schema refuses', '{"token":1}'],
    ['bytes that are not UTF-8', '�'],
  ])(
    'refuses %s as authentication and zeroes the secret',
    async (_case, text) => {
      const connection =
        text === '�'
          ? resolved('', { secret: new Uint8Array([0xff, 0xfe]) })
          : resolved(text);
      await expect(
        withProviderCredential(connection, expected, () => Promise.resolve()),
      ).rejects.toThrow('refused:authentication');
      expect(zeroed(connection.secret)).toBe(true);
    },
  );
});
