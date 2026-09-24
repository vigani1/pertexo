import type {
  IdentityWorkspaceDatabase,
  OidcLoginTransactionStore,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ApiIdentityConfig } from '../../src/platform/config/identity-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

const identityConfig: ApiIdentityConfig & {
  oidc: NonNullable<ApiIdentityConfig['oidc']>;
  secretEncryption: NonNullable<ApiIdentityConfig['secretEncryption']>;
} = {
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
  it('composes Better Auth without legacy OIDC dependencies', async () => {
    const runtime = await createApiIdentityRuntime(
      {
        publicWebOrigin: 'https://app.example.test',
        session: identityConfig.session,
        betterAuth: {
          secret: 'standalone-runtime-secret-at-least-32-characters',
          mailMode: 'local',
          providers: {},
        },
      },
      databaseConfig,
      {
        legacyOnlyUserCount: () => Promise.resolve(0),
        persistence: { database: identityDatabase() },
      },
    );

    expect(runtime.betterAuth).toBeDefined();
    expect(runtime.dependencies.provider).toBeUndefined();
    expect(runtime.dependencies.transactions).toBeUndefined();
    expect(runtime.dependencies.config.oidc).toBeUndefined();
    await runtime.close();
  });

  it('wires legacy OIDC as migration proof beside Better Auth', async () => {
    const runtime = await createApiIdentityRuntime(
      {
        ...identityConfig,
        publicWebOrigin: 'https://app.example.test',
        betterAuth: {
          secret: 'migration-runtime-secret-at-least-32-characters',
          mailMode: 'local',
          providers: {},
        },
      },
      databaseConfig,
      {
        persistence: {
          database: identityDatabase(),
          transactions: transactionStore(),
        },
      },
    );

    try {
      expect(runtime.dependencies.config.allowGenericOidcLogin).toBe(false);
      expect(runtime.dependencies.transactions).toBeDefined();
      const response = await runtime.betterAuth?.auth.handler(
        new Request('https://app.example.test/v1/auth/legacy-migration/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'google' }),
        }),
      );
      expect(response?.status).toBe(404);
      await expect(response?.json()).resolves.toEqual({
        code: 'MIGRATION_UNAVAILABLE',
      });
    } finally {
      await runtime.close();
    }
  });

  it('rejects OIDC composition seams without complete OIDC configuration', async () => {
    const withoutEncryption: ApiIdentityConfig = {
      oidc: identityConfig.oidc,
      session: identityConfig.session,
    };
    const standalone = {
      publicWebOrigin: 'https://app.example.test',
      session: identityConfig.session,
      betterAuth: {
        secret: 'standalone-runtime-secret-at-least-32-characters',
        mailMode: 'local' as const,
        providers: {},
      },
    };
    const provider = {
      authorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    };

    await expect(
      createApiIdentityRuntime(withoutEncryption, databaseConfig, {
        persistence: { database: identityDatabase() },
      }),
    ).rejects.toThrow(
      'OIDC configuration and transaction encryption must be supplied together',
    );
    await expect(
      createApiIdentityRuntime(standalone, databaseConfig, {
        provider,
        persistence: { database: identityDatabase() },
      }),
    ).rejects.toThrow('An OIDC provider requires OIDC configuration');

    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const transactionClose = vi.fn().mockResolvedValue(undefined);
    await expect(
      createApiIdentityRuntime(standalone, databaseConfig, {
        legacyOnlyUserCount: () => Promise.resolve(0),
        persistence: {
          database: identityDatabase(databaseClose),
          transactions: transactionStore(transactionClose),
        },
      }),
    ).rejects.toThrow('An OIDC transaction store requires OIDC configuration');
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(transactionClose).not.toHaveBeenCalled();
  });

  it('blocks standalone cutover when active legacy-only users remain', async () => {
    await expect(
      createApiIdentityRuntime(
        {
          publicWebOrigin: 'https://app.example.test',
          session: identityConfig.session,
          betterAuth: {
            secret: 'standalone-runtime-secret-at-least-32-characters',
            mailMode: 'local',
            providers: {},
          },
        },
        databaseConfig,
        {
          legacyOnlyUserCount: () => Promise.resolve(3),
          persistence: { database: identityDatabase() },
        },
      ),
    ).rejects.toThrow(
      'Standalone Better Auth cutover blocked: 3 active legacy-only user(s)',
    );
  });

  it('owns and closes the production database resources when none are injected', async () => {
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
    );
    expect(runtime.dependencies.persistence).toBe(
      runtime.dependencies.authorization,
    );
    await runtime.close();
  });

  it('forwards confidential-client and clock configuration through the public runtime', async () => {
    const clock = { now: () => new Date('2026-08-20T12:00:00.000Z') };
    const runtime = await createApiIdentityRuntime(
      {
        ...identityConfig,
        publicWebOrigin: 'https://app.example.test',
        oidc: {
          ...identityConfig.oidc,
          clientSecret: 'client-secret',
          callbackLandingPath: '/invitation/continue',
        },
      },
      databaseConfig,
      {
        clock,
        persistence: {
          database: identityDatabase(),
          transactions: transactionStore(),
        },
      },
    );

    expect(runtime.dependencies.clock).toBe(clock);
    expect(runtime.dependencies.provider).toBeDefined();
    expect(runtime.dependencies.config.publicWebOrigin).toBe(
      'https://app.example.test',
    );
    expect(runtime.dependencies.config.oidc?.callbackLandingPath).toBe(
      '/invitation/continue',
    );
    await runtime.close();
  });

  it('retains the provider injection seam and closes both pools once', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const transactionClose = vi.fn().mockResolvedValue(undefined);
    const provider = {
      authorizationUrl: vi.fn().mockReturnValue('https://example.test'),
      exchangeCode: vi.fn(),
    };
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      {
        provider,
        persistence: {
          database: identityDatabase(databaseClose),
          transactions: transactionStore(transactionClose),
        },
      },
    );

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
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      {
        persistence: {
          database: identityDatabase(databaseClose),
          transactions: transactionStore(transactionClose),
        },
      },
    );

    await expect(runtime.close()).rejects.toThrow(
      'Identity resource shutdown failed',
    );
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(transactionClose).toHaveBeenCalledOnce();
  });

  it('defers closer invocation so a synchronous throw cannot skip another owner', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const transactionClose = vi.fn(() => {
      throw new Error('synchronous OIDC close');
    });
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      {
        persistence: {
          database: identityDatabase(databaseClose),
          transactions: transactionStore(transactionClose),
        },
      },
    );

    await expect(runtime.close()).rejects.toThrow(
      'Identity resource shutdown failed',
    );
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(transactionClose).toHaveBeenCalledOnce();
  });

  it('closes an acquired database when transaction-store construction fails', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const constructionFailure = new Error('transaction construction failed');

    await expect(
      createApiIdentityRuntime(identityConfig, databaseConfig, {
        persistence: {
          databaseFactory: () => identityDatabase(databaseClose),
          transactionFactory: () => {
            throw constructionFailure;
          },
        },
      }),
    ).rejects.toBe(constructionFailure);
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('attempts both acquired closers when later composition fails', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const transactionClose = vi.fn(() => {
      throw new Error('synchronous OIDC close');
    });
    const compositionFailure = new Error('telemetry construction failed');

    await expect(
      createApiIdentityRuntime(identityConfig, databaseConfig, {
        persistence: {
          databaseFactory: () => identityDatabase(databaseClose),
          transactionFactory: () => transactionStore(transactionClose),
        },
        telemetry: {
          factory: () => {
            throw compositionFailure;
          },
        },
      }),
    ).rejects.toMatchObject({
      message: 'Identity runtime construction and cleanup failed',
      errors: [compositionFailure, expect.any(Error)],
    });
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(transactionClose).toHaveBeenCalledOnce();
  });

  it('adapts database transaction results to the application union', async () => {
    const transaction = {
      stateDigest: 'a'.repeat(64),
      browserBindingDigest: 'b'.repeat(64),
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce-value-that-is-long-enough',
      expiresAt: new Date('2026-08-20T12:05:00.000Z'),
    };
    const consume = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ok', transaction })
      .mockResolvedValueOnce({ status: 'missing' })
      .mockResolvedValueOnce({ status: 'expired' })
      .mockResolvedValueOnce({ status: 'replayed', transaction })
      .mockResolvedValueOnce({ status: 'binding_mismatch' });
    const create = vi.fn().mockResolvedValue(undefined);
    const databaseTransactions = { ...transactionStore(), create, consume };
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      {
        persistence: {
          database: identityDatabase(),
          transactions: databaseTransactions,
        },
      },
    );

    await runtime.dependencies.transactions?.create(transaction);
    expect(create).toHaveBeenCalledExactlyOnceWith(transaction);
    await expect(
      runtime.dependencies.transactions?.consume(
        transaction.stateDigest,
        transaction.browserBindingDigest,
        new Date('2026-08-20T12:00:00.000Z'),
      ),
    ).resolves.toEqual({ status: 'ok', transaction });
    for (const status of [
      'missing',
      'expired',
      'replayed',
      'binding_mismatch',
    ] as const) {
      await expect(
        runtime.dependencies.transactions?.consume(
          transaction.stateDigest,
          transaction.browserBindingDigest,
          new Date('2026-08-20T12:00:00.000Z'),
        ),
      ).resolves.toEqual({ status });
    }
    await runtime.close();
  });

  it('rejects a malformed successful database transaction result', async () => {
    const databaseTransactions = {
      ...transactionStore(),
      consume: vi.fn().mockResolvedValue({ status: 'ok' }),
    } as unknown as OidcLoginTransactionStore;
    const runtime = await createApiIdentityRuntime(
      identityConfig,
      databaseConfig,
      {
        persistence: {
          database: identityDatabase(),
          transactions: databaseTransactions,
        },
      },
    );

    await expect(
      runtime.dependencies.transactions?.consume(
        'a'.repeat(64),
        'b'.repeat(64),
        new Date('2026-08-20T12:00:00.000Z'),
      ),
    ).rejects.toThrow('OIDC transaction result is missing its value');
    await runtime.close();
  });
});
