import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';
import { expect, it, vi } from 'vitest';

import { TestConnectionUseCase } from '../../../src/connections/use-cases/management.js';

import {
  actor,
  authorization,
  connectionId,
  connectionTestPersistence,
  credential,
  workspaceId,
} from '../support/use-case-fixture.js';

export function registerRejectsDecryptedCredentialNonObjectJSON(): void {
  it('rejects a decrypted credential with a non-object JSON shape', async () => {
    const store = connectionTestPersistence();
    const plaintext = new TextEncoder().encode('null');
    const execute = vi.fn();

    await expect(
      new TestConnectionUseCase(store, authorization(), {
        encryption: {
          seal: vi.fn(),
          open: vi.fn(() => Promise.resolve(plaintext)),
        },
        httpClient: { execute },
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'malformed-decrypted-credential',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);

    expect(execute).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each(['email', 'slack', 'http'] as const)(
    'rejects a decrypted credential that does not match the %s test route',
    async (provider) => {
      const store = connectionTestPersistence();
      const plaintext = new TextEncoder().encode(
        JSON.stringify(
          provider === 'http'
            ? {
                type: 'slack_bot_token',
                botToken: 'xoxb-123456789-deeply-secret',
              }
            : credential,
        ),
      );
      await expect(
        new TestConnectionUseCase(store, authorization(), {
          encryption: {
            seal: vi.fn(),
            open: vi.fn(() => Promise.resolve(plaintext)),
          },
          httpClient: { execute: vi.fn() },
          applicationSecret: 'fixture-application-secret',
          telemetry: undefined,
          slackClient:
            provider === 'slack'
              ? undefined
              : { authTest: vi.fn().mockResolvedValue({ kind: 'succeeded' }) },
          emailClient:
            provider === 'email'
              ? undefined
              : {
                  sendNotification: vi
                    .fn()
                    .mockResolvedValue({ kind: 'succeeded' }),
                },
        }).execute({
          actor,
          routeWorkspaceId: workspaceId,
          connectionId,
          idempotencyKey: `mismatched-${provider}`,
          request: mismatchedConnectionTestRequest(provider),
        }),
      ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );
}

function mismatchedConnectionTestRequest(provider: string) {
  if (provider === 'http')
    return { url: 'https://provider.example.test/health' };
  if (provider === 'slack') return { providerKey: 'slack' };
  return { providerKey: 'email', sideEffectDisclosureAccepted: true };
}
