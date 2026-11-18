import { silent } from '../support/better-auth/api/environment.js';
import * as identityStores from '@pertexo/core/identity';
import * as tenantAccessStores from '@pertexo/core/tenant-access';
import type { IdentityWorkspaceStore } from '@pertexo/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  } as unknown as IdentityWorkspaceStore;
}

function createsIdentityDatabase(database: IdentityWorkspaceStore) {
  vi.spyOn(tenantAccessStores, 'createIdentityWorkspaceStore').mockReturnValue(
    database,
  );
}

/**
 * The composition's success path, and closing it, run in
 * bootstrap/production-composition.integration.test.ts and every real-API
 * test. These cases stay because no real stack fails a constructor or a
 * closer on demand, and the module has no seam for one.
 */
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

  it('closes its database once however often it is closed', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    createsIdentityDatabase(identityDatabase(databaseClose));
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      { logger: silent },
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
      { logger: silent },
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
      createApiIdentityRuntime(identityConfig, databaseConfig, {
        logger: silent,
      }),
    ).rejects.toBe(compositionFailure);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(federationClose).toHaveBeenCalledOnce();
  });
});
