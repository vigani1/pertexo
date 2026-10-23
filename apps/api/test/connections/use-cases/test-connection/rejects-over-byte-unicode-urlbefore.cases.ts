import type { SecureHttpRequest } from '@pertexo/integrations/server';
import { expect, it, vi } from 'vitest';
import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import type { ConnectionTestPersistence } from '../../../../src/connections/ports.js';

import { activeAccess, persistence, command } from './fixture.js';

export function registerRejectsOverByteUnicodeURLBefore(): void {
  it('rejects an over-byte Unicode URL before reservation or credential work', async () => {
    const store = persistence();
    const open = vi.fn();
    const execute = vi.fn();
    const authorization = {
      findAccess: vi.fn().mockResolvedValue(activeAccess()),
    };

    await expect(
      new TestConnectionUseCase(store, authorization, {
        encryption: { seal: vi.fn(), open },
        httpClient: { execute },
        applicationSecret: 'fixture-application-secret',
      }).execute(
        command({
          url: `https://provider.example.test/${'😀'.repeat(700)}`,
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(authorization.findAccess).toHaveBeenCalledOnce();
    expect(store.startConnectionTest).not.toHaveBeenCalled();
    expect(store.resolveConnectionTestSecret).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

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
        new TestConnectionUseCase(store, authorization, {
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

  it.each(['throws synchronously', 'rejects asynchronously'] as const)(
    'preserves provider failure and clears plaintext when abandonment $0',
    async (mode) => {
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
      >(() => {
        if (mode === 'throws synchronously') throw cleanupFailure;
        return Promise.reject(cleanupFailure);
      });
      const store = persistence({ abandonConnectionTest });
      const authorization = {
        findAccess: vi.fn().mockResolvedValue(activeAccess()),
      };

      await expect(
        new TestConnectionUseCase(store, authorization, {
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
    },
  );

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
      new TestConnectionUseCase(
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
}
