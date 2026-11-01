import * as identityStores from '@pertexo/core/identity';
import * as tenantAccessStores from '@pertexo/core/tenant-access';
import type { IdentityWorkspaceDatabase } from '@pertexo/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiIdentityConfig } from '../../src/platform/config/identity.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/runtime.module.js';

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
    signUpMode: 'open',
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

function createsIdentityDatabase(database: IdentityWorkspaceDatabase) {
  vi.spyOn(
    tenantAccessStores,
    'createIdentityWorkspaceDatabase',
  ).mockReturnValue(database);
}

/** Lets the real store be built and records how often its close runs. */
function ownedClose(
  factory:
    | 'createIdentityWorkspaceDatabase'
    | 'createApiTokenDatabase'
    | 'createDirectoryStore',
) {
  const stores = (factory === 'createDirectoryStore'
    ? identityStores
    : tenantAccessStores) as unknown as Record<
    typeof factory,
    (...arguments_: unknown[]) => { close(): Promise<void> }
  >;
  const original = stores[factory];
  let close: ReturnType<typeof vi.fn> | undefined;
  vi.spyOn(stores as Record<typeof factory, never>, factory).mockImplementation(
    ((...arguments_: unknown[]) => {
      const store = original(...arguments_);
      const closeStore = vi.fn(() => store.close());
      close = closeStore;
      // The stores are frozen; shadow close on an object that inherits the rest.
      return Object.defineProperty(
        Object.create(store) as typeof store,
        'close',
        {
          value: closeStore,
        },
      );
    }) as never,
  );
  return () => {
    if (close === undefined) throw new Error(`${factory} was never called`);
    return close;
  };
}

describe('identity runtime composition', () => {
  const federationClose = vi.fn<() => Promise<void>>();
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    federationClose.mockReset().mockResolvedValue(undefined);
    vi.spyOn(identityStores, 'createFederationManagementStore').mockReturnValue(
      {
        checkStoredSecrets: vi.fn().mockResolvedValue(undefined),
        close: federationClose,
      } as unknown as ReturnType<
        typeof identityStores.createFederationManagementStore
      >,
    );
  });

  it('composes Better Auth as the one session authority', async () => {
    createsIdentityDatabase(identityDatabase());
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
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
    const closes = [
      ownedClose('createIdentityWorkspaceDatabase'),
      ownedClose('createApiTokenDatabase'),
      ownedClose('createDirectoryStore'),
    ];
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
    );
    await runtime.close();
    for (const close of closes) expect(close()).toHaveBeenCalledOnce();
    expect(federationClose).toHaveBeenCalledOnce();
  });

  it('closes its database once however often it is closed', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    createsIdentityDatabase(identityDatabase(databaseClose));
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(federationClose).toHaveBeenCalledOnce();
  });

  it('reports a synchronous closer throw as an aggregate shutdown failure', async () => {
    const databaseClose = vi.fn(() => {
      throw new Error('synchronous database close');
    });
    createsIdentityDatabase(identityDatabase(databaseClose));
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
    );

    await expect(runtime.close()).rejects.toThrow(
      'Identity resource shutdown failed',
    );
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(federationClose).toHaveBeenCalledOnce();
  });

  it('closes the acquired database when later composition fails', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const compositionFailure = new Error('stored secrets could not be read');
    createsIdentityDatabase(identityDatabase(databaseClose));
    vi.mocked(identityStores.createFederationManagementStore).mockReturnValue({
      checkStoredSecrets: vi.fn().mockRejectedValue(compositionFailure),
      close: federationClose,
    } as unknown as ReturnType<
      typeof identityStores.createFederationManagementStore
    >);

    await expect(
      createApiIdentityRuntime(identityConfig, databaseConfig),
    ).rejects.toBe(compositionFailure);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(federationClose).toHaveBeenCalledOnce();
  });
});
