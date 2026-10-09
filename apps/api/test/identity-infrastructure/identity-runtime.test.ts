import type { IdentityWorkspaceDatabase } from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ApiIdentityConfig } from '../../src/platform/config/identity-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

const identityConfig: ApiIdentityConfig = {
  publicWebOrigin: 'https://app.example.test',
  session: {
    ttlMillis: 60_000,
    secureCookie: true,
    sameSite: 'lax',
  },
  betterAuth: {
    secret: 'identity-runtime-secret-at-least-32-characters',
    mailMode: 'local',
    providers: {},
  },
};

const databaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
};

function identityDatabase(
  close: () => unknown = vi.fn().mockResolvedValue(undefined),
) {
  return {
    createUser: vi.fn(),
    findUserById: vi.fn(),
    findWorkspaceAccess: vi.fn(),
    createWorkspaceWithOwner: vi.fn(),
    requestWorkspaceLifecycleOperation: vi.fn(),
    readWorkspaceLifecycleOperation: vi.fn(),
    close,
  } as unknown as IdentityWorkspaceDatabase;
}

describe('identity runtime composition', () => {
  it('composes Better Auth as the one session authority', async () => {
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      { persistence: { database: identityDatabase() } },
    );

    expect(runtime.betterAuth).toBeDefined();
    expect(runtime.dependencies.sessions).toBeDefined();
    expect(runtime.dependencies.persistence).toBe(
      runtime.dependencies.authorization,
    );
    expect(runtime.dependencies.config.publicWebOrigin).toBe(
      'https://app.example.test',
    );
    await runtime.close();
  });

  it('owns and closes the production database resources when none are injected', async () => {
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
    );
    await runtime.close();
  });

  it('forwards the clock through the public runtime', async () => {
    const clock = { now: () => new Date('2026-08-20T12:00:00.000Z') };
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      { clock, persistence: { database: identityDatabase() } },
    );

    expect(runtime.dependencies.clock).toBe(clock);
    await runtime.close();
  });

  it('closes an injected database once however often it is closed', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      { persistence: { database: identityDatabase(databaseClose) } },
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('reports a synchronous closer throw as an aggregate shutdown failure', async () => {
    const databaseClose = vi.fn(() => {
      throw new Error('synchronous database close');
    });
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      { persistence: { database: identityDatabase(databaseClose) } },
    );

    await expect(runtime.close()).rejects.toThrow(
      'Identity resource shutdown failed',
    );
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('closes the acquired database when later composition fails', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const compositionFailure = new Error('telemetry construction failed');

    await expect(
      createApiIdentityRuntime(identityConfig, databaseConfig, {
        persistence: {
          databaseFactory: () => identityDatabase(databaseClose),
        },
        telemetry: {
          factory: () => {
            throw compositionFailure;
          },
        },
      }),
    ).rejects.toBe(compositionFailure);
    expect(databaseClose).toHaveBeenCalledOnce();
  });
});
