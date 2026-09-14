import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createIdentityWorkspaceDatabase,
  createOidcLoginTransactionStore,
  type DatabaseConfig,
  type DatabaseRuntime,
  type IdentityWorkspaceDatabase,
  type OidcLoginTransactionStore as DatabaseOidcLoginTransactionStore,
} from '@pertexo/database/api';

import {
  GenericOidcProviderAdapter,
  createOidcSecretEncryptionAdapter,
} from '../../identity-infrastructure/index.js';
import {
  DatabaseIdentityWorkspaceAdapter,
  IdentityWorkspaceModule,
  createIdentityWorkspaceTelemetry,
  type IdentityWorkspaceTelemetry,
  type IdentityWorkspaceDependencies,
} from '../../identity-workspace/index.js';
import type {
  IdentityClock,
  OidcLoginTransactionStore,
  OidcProviderPort,
} from '../../identity/index.js';
import type { ApiIdentityConfig } from '../config/api-config.js';

export type ApiIdentityRuntime = Readonly<{
  dependencies: IdentityWorkspaceDependencies;
  close(): Promise<void>;
}>;

export type ApiIdentityRuntimeOverrides = Readonly<{
  provider?: OidcProviderPort;
  clock?: IdentityClock;
  persistence?: Readonly<{
    database?: IdentityWorkspaceDatabase;
    databaseFactory?: typeof createIdentityWorkspaceDatabase;
    transactions?: DatabaseOidcLoginTransactionStore;
    transactionFactory?: typeof createOidcLoginTransactionStore;
  }>;
  telemetry?: Readonly<{
    value?: IdentityWorkspaceTelemetry;
    factory?: () => IdentityWorkspaceTelemetry;
  }>;
}>;

/**
 * Composes the server-only identity infrastructure while retaining narrow
 * injection seams for real-database/fake-provider integration tests.
 */
export async function createApiIdentityRuntime(
  config: ApiIdentityConfig,
  databaseConfig: DatabaseConfig,
  overrides: ApiIdentityRuntimeOverrides = {},
  runtime?: DatabaseRuntime,
): Promise<ApiIdentityRuntime> {
  const persistenceOverrides = overrides.persistence ?? {};
  const telemetryOverrides = overrides.telemetry ?? {};
  const provider =
    overrides.provider ??
    new GenericOidcProviderAdapter({
      issuer: config.oidc.issuer,
      authorizationEndpoint: config.oidc.authorizationEndpoint,
      tokenEndpoint: config.oidc.tokenEndpoint,
      jwksUri: config.oidc.jwksUri,
      redirectUri: config.oidc.redirectUri,
      clientId: config.oidc.clientId,
      ...(config.oidc.clientSecret === undefined
        ? {}
        : { clientSecret: config.oidc.clientSecret }),
      allowedAlgorithms: [...config.oidc.allowedAlgorithms],
      timeoutMillis: config.oidc.timeoutMillis,
      allowInsecureHttpForTests: config.oidc.allowInsecureHttpForTests,
    });
  const encryption = createOidcSecretEncryptionAdapter(config.secretEncryption);
  let identityDatabase: IdentityWorkspaceDatabase | undefined;
  let transactionDatabase: DatabaseOidcLoginTransactionStore | undefined;
  try {
    identityDatabase =
      persistenceOverrides.database ??
      (persistenceOverrides.databaseFactory ?? createIdentityWorkspaceDatabase)(
        databaseConfig,
        runtime,
      );
    transactionDatabase =
      persistenceOverrides.transactions ??
      (
        persistenceOverrides.transactionFactory ??
        createOidcLoginTransactionStore
      )(databaseConfig, encryption, runtime);
    const transactions = adaptTransactionStore(transactionDatabase);
    const persistence = new DatabaseIdentityWorkspaceAdapter(identityDatabase);
    const telemetry =
      telemetryOverrides.value ??
      (telemetryOverrides.factory ?? productionIdentityTelemetry)();
    const acquiredIdentityDatabase = identityDatabase;
    const acquiredTransactionDatabase = transactionDatabase;
    let closePromise: Promise<void> | undefined;

    return Object.freeze({
      dependencies: Object.freeze({
        config: Object.freeze({
          oidc: Object.freeze({
            issuer: config.oidc.issuer,
            authorizationEndpoint: config.oidc.authorizationEndpoint,
            clientId: config.oidc.clientId,
            redirectUri: config.oidc.redirectUri,
            scopes: config.oidc.scopes,
            transactionTtlMillis: config.oidc.transactionTtlMillis,
          }),
          session: config.session,
        }),
        provider,
        transactions,
        persistence,
        authorization: persistence,
        ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
        telemetry,
      }),
      close: (): Promise<void> => {
        closePromise ??= closeIdentityResources(
          acquiredIdentityDatabase,
          acquiredTransactionDatabase,
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectIdentityCloseFailures(
      identityDatabase,
      transactionDatabase,
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Identity runtime construction and cleanup failed',
      );
    throw error;
  }
}

function productionIdentityTelemetry(): IdentityWorkspaceTelemetry {
  return createIdentityWorkspaceTelemetry({
    meter: metrics.getMeter('@pertexo/api.identity-workspace', '0.0.0'),
    tracer: trace.getTracer('@pertexo/api.identity-workspace', '0.0.0'),
  });
}

async function closeIdentityResources(
  database: IdentityWorkspaceDatabase,
  transactions: DatabaseOidcLoginTransactionStore,
): Promise<void> {
  const failures = await collectIdentityCloseFailures(database, transactions);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Identity resource shutdown failed');
  }
}

async function collectIdentityCloseFailures(
  database: IdentityWorkspaceDatabase | undefined,
  transactions: DatabaseOidcLoginTransactionStore | undefined,
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => transactions?.close()),
    Promise.resolve().then(() => database?.close()),
  ]);
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function adaptTransactionStore(
  database: DatabaseOidcLoginTransactionStore,
): OidcLoginTransactionStore {
  return Object.freeze<OidcLoginTransactionStore>({
    create: (transaction) => database.create(transaction),
    consume: async (stateDigest, browserBindingDigest, now) => {
      const result = await database.consume(
        stateDigest,
        browserBindingDigest,
        now,
      );
      switch (result.status) {
        case 'ok': {
          const transaction = (
            result as Readonly<{
              transaction?: typeof result.transaction;
            }>
          ).transaction;
          if (transaction === undefined)
            throw new Error('OIDC transaction result is missing its value');
          return Object.freeze({
            status: 'ok' as const,
            transaction,
          });
        }
        case 'missing':
        case 'expired':
        case 'replayed':
        case 'binding_mismatch':
          return Object.freeze({ status: result.status });
      }
    },
  });
}

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class IdentityRuntimeModule {
  public static register(runtime: ApiIdentityRuntime): DynamicModule {
    const feature = IdentityWorkspaceModule.register(runtime.dependencies);
    return {
      module: IdentityRuntimeModule,
      controllers: feature.controllers ?? [],
      providers: feature.providers ?? [],
      exports: feature.exports ?? [],
    };
  }
}
