import type { ConnectionStore } from '@pertexo/core/testing';

import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  connectionId,
  secretVersionId,
  context,
  databaseConfig,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerAdmissionCancellation(): void {
  it.each([true, false])(
    'gives cancellation precedence when rate admission settles late with allowed=%s',
    async (allowed) => {
      const admission = Promise.withResolvers<
        | { allowed: true }
        | {
            allowed: false;
            retryAfterSeconds: number;
            limitedDimension: 'connection';
          }
      >();
      const resolveConnectionSecret = vi.fn();
      const runtime = await createOwnedCapabilities(
        { database: databaseConfig },
        {
          connectionDatabase: {
            resolveConnectionSecret,
            assertConnectionSecretCurrent: vi.fn(),
          },
          connectionEncryption: { open: vi.fn() },
          providerRateLimiter: { consume: () => admission.promise },
        },
      );
      const connections = runtime.factories.connections?.(context);
      if (connections === undefined)
        throw new Error('connection capability missing');
      const controller = new AbortController();
      const resolving = connections.resolve({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        purpose: 'http.request.execute',
        signal: controller.signal,
      });
      controller.abort();
      admission.resolve(
        allowed
          ? { allowed: true }
          : {
              allowed: false,
              retryAfterSeconds: 3,
              limitedDimension: 'connection',
            },
      );

      await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
      expect(resolveConnectionSecret).not.toHaveBeenCalled();
      await runtime.close();
    },
  );

  it('propagates cancellation into resolution and rechecks it before decryption', async () => {
    const resolvedSecret = Promise.withResolvers<{
      connection: {
        id: string;
        workspaceId: string;
        providerKey: string;
        authType: 'http_headers';
      };
      secretVersionId: string;
      sealed: never;
    }>();
    const resolveConnectionSecret = vi
      .fn()
      .mockReturnValue(resolvedSecret.promise);
    const open = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret: resolveConnectionSecret as never,
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: { open },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');
    const controller = new AbortController();
    const resolving = connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(resolveConnectionSecret).toHaveBeenCalledOnce();
    });
    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();
    resolvedSecret.resolve({
      connection: {
        id: connectionId,
        workspaceId,
        providerKey: 'http',
        authType: 'http_headers',
      },
      secretVersionId,
      sealed: {} as never,
    });

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
    expect(open).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('passes Slack bot-token identity through the shared JIT connection fence', async () => {
    const resolveConnectionSecret = vi.fn(() =>
      Promise.resolve({
        connection: {
          id: connectionId,
          workspaceId,
          providerKey: 'slack',
          name: 'Slack',
          authType: 'slack_bot_token' as const,
          status: 'active' as const,
          currentSecretVersionId: secretVersionId,
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
          createdBy: '88888888-8888-4888-8888-888888888888',
          accessMode: 'workspace' as const,
          createdAt: new Date('2026-08-24T00:00:00.000Z'),
          updatedAt: new Date('2026-08-24T00:00:00.000Z'),
        },
        secretVersionId,
        sealed: {
          kmsKeyReference: 'alias/pertexo',
          encryptedDataKey: 'YQ',
          ciphertext: 'Yg',
          nonce: 'YWFhYWFhYWFhYWFh',
          tag: 'YWFhYWFhYWFhYWFhYWFhYQ',
        },
      }),
    );
    const assertConnectionSecretCurrent = vi.fn(() => Promise.resolve());
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret,
          assertConnectionSecretCurrent,
        } satisfies Pick<
          ConnectionStore,
          'assertConnectionSecretCurrent' | 'resolveConnectionSecret'
        >,
        connectionEncryption: {
          open: () => Promise.resolve(new TextEncoder().encode('slack-secret')),
        },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections?.assertCurrent === undefined)
      throw new Error('connection capability missing');
    const signal = new AbortController().signal;

    await connections.resolve({
      connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      purpose: 'slack.send_message.execute',
      signal,
    });
    await connections.assertCurrent({
      connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      secretVersionId,
      signal,
    });

    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProviderKey: 'slack',
        purpose: 'slack.send_message.execute',
      }),
    );
    expect(assertConnectionSecretCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProviderKey: 'slack',
        expectedAuthType: 'slack_bot_token',
      }),
    );
    await runtime.close();
  });
}
