import type {
  IdentityWorkspaceDatabase,
  OidcLoginTransactionStore,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ApiIdentityConfig } from '../../src/platform/config/api-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

const identityConfig: ApiIdentityConfig = {
  oidc: {
    issuer: 'https://identity.example.test',
    authorizationEndpoint: 'https://identity.example.test/authorize',
    tokenEndpoint: 'https://identity.example.test/token',
    jwksUri: 'https://identity.example.test/jwks',
    clientId: 'client',
    redirectUri: 'https://api.example.test/v1/auth/oidc/callback',
    scopes: ['openid'],
    allowedAlgorithms: ['RS256'],
    timeoutMillis: 1_000,
    transactionTtlMillis: 300_000,
    allowInsecureHttpForTests: false,
  },
  secretEncryption: {
    current: { version: 'v1', key: Buffer.alloc(32, 7).toString('base64') },
    previous: [],
  },
  session: {
    ttlMillis: 60_000,
    secureCookie: true,
    sameSite: 'lax',
  },
};

const databaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
};

function identityDatabase(close = vi.fn().mockResolvedValue(undefined)) {
  return {
    createUser: vi.fn(),
    findUserById: vi.fn(),
    linkAuthIdentity: vi.fn(),
    resolveOrCreateIdentity: vi.fn(),
    findWorkspaceAccess: vi.fn(),
    findAuthIdentity: vi.fn(),
    createSession: vi.fn(),
    findActiveSessionByDigest: vi.fn(),
    revokeSession: vi.fn(),
    revokeSessionByDigest: vi.fn(),
    createWorkspaceWithOwner: vi.fn(),
    requestWorkspaceLifecycleOperation: vi.fn(),
    readWorkspaceLifecycleOperation: vi.fn(),
    close,
  } as unknown as IdentityWorkspaceDatabase;
}

function transactionStore(close = vi.fn().mockResolvedValue(undefined)) {
  return {
    create: vi.fn(),
    consume: vi.fn(),
    close,
  } as unknown as OidcLoginTransactionStore;
}

describe('identity runtime composition', () => {
  it('owns and closes the production database resources when none are injected', async () => {
    const runtime = createApiIdentityRuntime(identityConfig, databaseConfig);
    expect(runtime.dependencies.persistence).toBe(
      runtime.dependencies.authorization,
    );
    await runtime.close();
  });

  it('forwards confidential-client and clock configuration through the public runtime', async () => {
    const clock = { now: () => new Date('2026-08-20T12:00:00.000Z') };
    const runtime = createApiIdentityRuntime(
      {
        ...identityConfig,
        oidc: { ...identityConfig.oidc, clientSecret: 'client-secret' },
      },
      databaseConfig,
      {
        clock,
        database: identityDatabase(),
        transactions: transactionStore(),
      },
    );

    expect(runtime.dependencies.clock).toBe(clock);
    expect(runtime.dependencies.provider).toBeDefined();
    await runtime.close();
  });

  it('retains the provider injection seam and closes both pools once', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const transactionClose = vi.fn().mockResolvedValue(undefined);
    const provider = {
      authorizationUrl: vi.fn().mockReturnValue('https://example.test'),
      exchangeCode: vi.fn(),
    };
    const runtime = createApiIdentityRuntime(identityConfig, databaseConfig, {
      provider,
      database: identityDatabase(databaseClose),
      transactions: transactionStore(transactionClose),
    });

    expect(runtime.dependencies.provider).toBe(provider);
    expect(runtime.dependencies.persistence).toBe(
      runtime.dependencies.authorization,
    );
    await Promise.all([runtime.close(), runtime.close()]);

    expect(databaseClose).toHaveBeenCalledOnce();
    expect(transactionClose).toHaveBeenCalledOnce();
  });

  it('attempts every resource close and reports aggregate shutdown failure', async () => {
    const databaseClose = vi.fn().mockRejectedValue(new Error('database'));
    const transactionClose = vi.fn().mockRejectedValue(new Error('oidc'));
    const runtime = createApiIdentityRuntime(identityConfig, databaseConfig, {
      database: identityDatabase(databaseClose),
      transactions: transactionStore(transactionClose),
    });

    await expect(runtime.close()).rejects.toThrow(
      'Identity resource shutdown failed',
    );
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(transactionClose).toHaveBeenCalledOnce();
  });
});
