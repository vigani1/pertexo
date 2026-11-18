import { describe, expect, it, vi } from 'vitest';
import { TestConnectionService } from '../../../src/connections/testing/test-connection.js';
import type {
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from '../../../src/connections/ports.js';
import {
  activeAccess,
  persistence,
  command,
} from './test-connection-fixture.js';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import type { SecureHttpRequest } from '@pertexo/secrets/server';

/**
 * The provider answers and their stored outcomes run end to end in
 * provider-test.integration.test.ts, the outcome table in testing/outcomes.test.ts
 * and destination tests in destination-test-route.integration.test.ts. These
 * cases stay because no real stack produces them on demand: access lost between
 * the claim and the secret read (an exact race), the database failing to record
 * dispatch or abandonment, and a stored secret the API itself could never have
 * written.
 */
describe('connection testing security and cleanup regressions', () => {
  it.each([
    ['missing membership', undefined],
    [
      'inactive membership',
      { ...activeAccess(), membershipStatus: 'suspended' as const },
    ],
    ['downgraded membership', { ...activeAccess(), role: 'viewer' as const }],
    [
      'suspended workspace',
      { ...activeAccess(), workspaceStatus: 'suspended' as const },
    ],
  ] as const)(
    'abandons before credential egress when reauthorization sees %s',
    async (_name, deniedAccess) => {
      const store = persistence();
      const authorization = {
        findAccess: vi
          .fn()
          .mockResolvedValueOnce(activeAccess())
          .mockResolvedValueOnce(deniedAccess),
      };
      const open = vi.fn();
      const execute = vi.fn();

      await expect(
        new TestConnectionService(store, authorization, {
          encryption: { seal: vi.fn(), open },
          httpClient: { execute },
          applicationSecret: 'fixture-application-secret',
        }).execute(command({ url: 'https://provider.example.test/health' })),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(authorization.findAccess).toHaveBeenCalledTimes(2);
      expect(store.startConnectionTest).toHaveBeenCalledOnce();
      expect(store.resolveConnectionTestSecret).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(store.completeConnectionTest).not.toHaveBeenCalled();
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    },
  );

  it('preserves the provider failure and clears plaintext when abandonment fails', async () => {
    const providerFailure = new Error('provider failed');
    const cleanupFailure = new Error('abandon failed');
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        type: 'http_headers',
        headers: { authorization: 'Bearer secret' },
      }),
    );
    const abandonConnectionTest = vi.fn<
      ConnectionTestPersistence['abandonConnectionTest']
    >(() => Promise.reject(cleanupFailure));
    const store = persistence({ abandonConnectionTest });
    const authorization = {
      findAccess: vi.fn().mockResolvedValue(activeAccess()),
    };

    await expect(
      new TestConnectionService(store, authorization, {
        encryption: {
          seal: vi.fn(),
          open: vi.fn(() => Promise.resolve(plaintext)),
        },
        httpClient: { execute: vi.fn(() => Promise.reject(providerFailure)) },
        applicationSecret: 'fixture-application-secret',
      }).execute(command({ url: 'https://provider.example.test/health' })),
    ).rejects.toBe(providerFailure);
    expect(abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('does not simulate network work after an awaited dispatch marker fails', async () => {
    const markerFailure = new Error('dispatch marker failed');
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        type: 'http_headers',
        headers: { authorization: 'Bearer secret' },
      }),
    );
    const store = persistence({
      markConnectionTestDispatched: vi.fn(() => Promise.reject(markerFailure)),
    });
    const networkAction = vi.fn();
    const execute = vi.fn(async (input: SecureHttpRequest) => {
      await input.beforeDispatch();
      networkAction();
      return {
        status: 204,
        headers: {},
        body: new Uint8Array(),
        bodyEncoding: 'utf8' as const,
        finalUrl: input.url,
        redirectCount: 0,
      };
    });

    await expect(
      new TestConnectionService(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        {
          encryption: {
            seal: vi.fn(),
            open: vi.fn(() => Promise.resolve(plaintext)),
          },
          httpClient: { execute },
          applicationSecret: 'fixture-application-secret',
        },
      ).execute(command({ url: 'https://provider.example.test/health' })),
    ).rejects.toBe(markerFailure);
    expect(execute).toHaveBeenCalledOnce();
    expect(networkAction).not.toHaveBeenCalled();
    expect(store.completeConnectionTest).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    {
      name: 'invalid UTF-8',
      request: { url: 'https://provider.example.test/health' } as const,
      bytes: () => Uint8Array.from([0xff]),
      clients: 'http' as const,
    },
    {
      name: 'malformed JSON',
      request: { url: 'https://provider.example.test/health' } as const,
      bytes: () => new TextEncoder().encode('{'),
      clients: 'http' as const,
    },
    {
      name: 'invalid credential fields',
      request: { providerKey: 'slack' } as const,
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            type: 'slack_bot_token',
            botToken: 'short',
          }),
        ),
      clients: 'slack' as const,
    },
  ])(
    'rejects $name before provider dispatch',
    async ({ request, bytes, clients }) => {
      const plaintext = bytes();
      const execute = vi.fn();
      const authTest = vi.fn();
      const store = persistence();
      const slackClient: Pick<ConnectionSlackClient, 'authTest'> | undefined =
        clients === 'slack' ? { authTest } : undefined;

      await expect(
        new TestConnectionService(
          store,
          { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
          {
            encryption: {
              seal: vi.fn(),
              open: vi.fn(() => Promise.resolve(plaintext)),
            },
            httpClient: { execute },
            applicationSecret: 'fixture-application-secret',
            telemetry: undefined,
            slackClient: slackClient,
          },
        ).execute(command(request)),
      ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
      expect(execute).not.toHaveBeenCalled();
      expect(authTest).not.toHaveBeenCalled();
      expect(store.completeConnectionTest).not.toHaveBeenCalled();
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );
});
