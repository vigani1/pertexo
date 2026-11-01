import { ProviderCredentialInvalidError } from '@pertexo/node-sdk/server';

import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  connectionId,
  secretVersionId,
  context,
  databaseConfig,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerConnectionSecretCleanup(): void {
  it('checks cancellation before lookup and zeroes a secret canceled after decryption', async () => {
    const secret = new TextEncoder().encode('secret');
    const controller = new AbortController();
    const abortAfterOpen: { current?: AbortController } = {};
    const resolveConnectionSecret = vi.fn(() =>
      Promise.resolve({
        connection: {
          id: connectionId,
          workspaceId,
          providerKey: 'http',
          authType: 'http_headers' as const,
        },
        secretVersionId,
        sealed: {} as never,
      }),
    );
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        connectionStore: {
          resolveConnectionSecret: resolveConnectionSecret as never,
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: {
          open: () => {
            abortAfterOpen.current?.abort();
            return Promise.resolve(secret);
          },
        },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');
    const request = {
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers' as const,
      purpose: 'http.request.execute',
      signal: controller.signal,
    };
    controller.abort();
    await expect(connections.resolve(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(resolveConnectionSecret).not.toHaveBeenCalled();

    const secondController = new AbortController();
    abortAfterOpen.current = secondController;
    await expect(
      connections.resolve({ ...request, signal: secondController.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(secret.every((byte) => byte === 0)).toBe(true);
    await runtime.close();
  });

  it('awaits late decryption, clears its secret, and refuses it after cancellation', async () => {
    const decrypted = Promise.withResolvers<Uint8Array>();
    const open = vi.fn().mockReturnValue(decrypted.promise);
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        connectionStore: {
          resolveConnectionSecret: vi.fn().mockResolvedValue({
            connection: {
              id: connectionId,
              workspaceId,
              providerKey: 'http',
              authType: 'http_headers',
            },
            secretVersionId,
            sealed: {},
          }),
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
      expect(open).toHaveBeenCalledOnce();
    });
    controller.abort();
    const secret = new TextEncoder().encode('late-secret');
    decrypted.resolve(secret);

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
    expect(secret.every((byte) => byte === 0)).toBe(true);
    await runtime.close();
  });

  it('rejects a resolved connection with another auth type', async () => {
    const connection = {
      authType: 'slack_bot_token',
      id: connectionId,
      workspaceId,
    } as const;
    const open = vi.fn();
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        connectionStore: {
          resolveConnectionSecret: () =>
            Promise.resolve({
              connection: { ...connection, providerKey: 'http' } as never,
              secretVersionId,
              sealed: {} as never,
            }),
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
    await expect(
      connections.resolve({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        purpose: 'http.request.execute',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ProviderCredentialInvalidError);
    expect(open).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('rejects unsupported connection currency auth and post-check cancellation', async () => {
    const controller = new AbortController();
    const assertConnectionSecretCurrent = vi.fn(() => {
      controller.abort();
      return Promise.resolve();
    });
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      {
        connectionStore: {
          resolveConnectionSecret: vi.fn(),
          assertConnectionSecretCurrent,
        },
        connectionEncryption: { open: vi.fn() },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const assertCurrent =
      runtime.factories.connections?.(context).assertCurrent;
    if (assertCurrent === undefined)
      throw new Error('connection capability missing');
    await expect(
      assertCurrent({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'unsupported',
        secretVersionId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ProviderCredentialInvalidError);
    await expect(
      assertCurrent({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        secretVersionId,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await runtime.close();
  });
}
