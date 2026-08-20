import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createIdentityWorkspaceDatabase,
  createOidcLoginTransactionStore,
  type DatabaseConfig,
  type IdentityWorkspaceDatabase,
  type OidcLoginTransactionStore,
} from '@pertexo/database';

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
import type { OidcProviderPort } from '../../identity/index.js';
import type { ApiIdentityConfig } from '../config/api-config.js';

export type ApiIdentityRuntime = Readonly<{
  dependencies: IdentityWorkspaceDependencies;
  close(): Promise<void>;
}>;

export type ApiIdentityRuntimeOverrides = Readonly<{
  provider?: OidcProviderPort;
  database?: IdentityWorkspaceDatabase;
  transactions?: OidcLoginTransactionStore;
  telemetry?: IdentityWorkspaceTelemetry;
}>;

/**
 * Composes the server-only identity infrastructure while retaining narrow
 * injection seams for real-database/fake-provider integration tests.
 */
export function createApiIdentityRuntime(
  config: ApiIdentityConfig,
  databaseConfig: DatabaseConfig,
  overrides: ApiIdentityRuntimeOverrides = {},
): ApiIdentityRuntime {
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
  const identityDatabase =
    overrides.database ?? createIdentityWorkspaceDatabase(databaseConfig);
  const transactions =
    overrides.transactions ??
    createOidcLoginTransactionStore(databaseConfig, encryption);
  const persistence = new DatabaseIdentityWorkspaceAdapter(identityDatabase);
  const telemetry =
    overrides.telemetry ??
    createIdentityWorkspaceTelemetry({
      meter: metrics.getMeter('@pertexo/api.identity-workspace', '0.0.0'),
      tracer: trace.getTracer('@pertexo/api.identity-workspace', '0.0.0'),
    });
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
      telemetry,
    }),
    close: (): Promise<void> => {
      closePromise ??= closeIdentityResources(identityDatabase, transactions);
      return closePromise;
    },
  });
}

async function closeIdentityResources(
  database: IdentityWorkspaceDatabase,
  transactions: OidcLoginTransactionStore,
): Promise<void> {
  const results = await Promise.allSettled([
    transactions.close(),
    database.close(),
  ]);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason as unknown);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Identity resource shutdown failed');
  }
}

class IdentityRuntimeShutdown implements OnApplicationShutdown {
  public constructor(private readonly runtime: ApiIdentityRuntime) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.runtime.close();
  }
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
      providers: [
        ...(feature.providers ?? []),
        {
          provide: IdentityRuntimeShutdown,
          useFactory: () => new IdentityRuntimeShutdown(runtime),
        },
      ],
      exports: feature.exports ?? [],
    };
  }
}
