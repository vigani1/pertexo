import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { Pool } from 'pg';
import {
  createIdentityWorkspaceDatabase,
  createAuthenticationMailEnqueueStore,
  createOidcLoginTransactionStore,
  type DatabaseConfig,
  type DatabaseRuntime,
  type IdentityWorkspaceDatabase,
  type AuthenticationMailEnqueueStore,
  type OidcLoginTransactionStore as DatabaseOidcLoginTransactionStore,
} from '@pertexo/database/api';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';

import {
  GenericOidcProviderAdapter,
  BetterAuthSessionService,
  DurableAuthenticationMail,
  createBetterAuthRuntime,
  disabledAuthenticationMail,
  LocalAuthenticationMailSink,
  createOidcSecretEncryptionAdapter,
  type AuthenticationMail,
  type BetterAuthRuntime,
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
import type { ApiIdentityConfig } from '../config/identity-config.js';

export type ApiIdentityRuntime = Readonly<{
  dependencies: IdentityWorkspaceDependencies;
  betterAuth?: BetterAuthRuntime;
  close(): Promise<void>;
}>;

export type ApiIdentityRuntimeOverrides = Readonly<{
  provider?: OidcProviderPort;
  clock?: IdentityClock;
  authenticationMail?: AuthenticationMail;
  legacyOnlyUserCount?: () => Promise<number>;
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
  if ((config.oidc === undefined) !== (config.secretEncryption === undefined))
    throw new TypeError(
      'OIDC configuration and transaction encryption must be supplied together',
    );
  if (config.oidc === undefined && overrides.provider !== undefined)
    throw new TypeError('An OIDC provider requires OIDC configuration');
  const provider =
    config.oidc === undefined
      ? undefined
      : (overrides.provider ??
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
        }));
  const invitationEncryptionConfig =
    config.invitationTokenEncryption ?? config.secretEncryption;
  const invitationEncryption =
    invitationEncryptionConfig === undefined
      ? undefined
      : createApplicationSecretEnvelope(invitationEncryptionConfig);
  let identityDatabase: IdentityWorkspaceDatabase | undefined;
  let transactionDatabase: DatabaseOidcLoginTransactionStore | undefined;
  let betterAuthRuntime: BetterAuthRuntime | undefined;
  let authenticationMailStore: AuthenticationMailEnqueueStore | undefined;
  try {
    if (config.betterAuth !== undefined && config.oidc === undefined) {
      const legacyOnlyUsers = await (
        overrides.legacyOnlyUserCount ??
        (() => countLegacyOnlyUsers(databaseConfig))
      )();
      if (legacyOnlyUsers > 0)
        throw new Error(
          `Standalone Better Auth cutover blocked: ${String(legacyOnlyUsers)} active legacy-only user(s) require an approved recovery mapping`,
        );
    }
    identityDatabase =
      persistenceOverrides.database ??
      (persistenceOverrides.databaseFactory ?? createIdentityWorkspaceDatabase)(
        databaseConfig,
        runtime,
      );
    if (config.oidc !== undefined && config.secretEncryption !== undefined) {
      const encryption = createOidcSecretEncryptionAdapter(
        config.secretEncryption,
      );
      transactionDatabase =
        persistenceOverrides.transactions ??
        (
          persistenceOverrides.transactionFactory ??
          createOidcLoginTransactionStore
        )(databaseConfig, encryption, runtime);
    } else if (persistenceOverrides.transactions !== undefined) {
      throw new TypeError(
        'An OIDC transaction store requires OIDC configuration',
      );
    }
    const transactions =
      transactionDatabase === undefined
        ? undefined
        : adaptTransactionStore(transactionDatabase);
    const persistence = new DatabaseIdentityWorkspaceAdapter(identityDatabase);
    const telemetry =
      telemetryOverrides.value ??
      (telemetryOverrides.factory ?? productionIdentityTelemetry)();
    if (config.betterAuth !== undefined) {
      const publicOrigin = identityPublicOrigin(config);
      let mail = overrides.authenticationMail;
      if (mail === undefined && config.betterAuth.mailMode === 'local')
        mail = new LocalAuthenticationMailSink();
      if (mail === undefined && config.betterAuth.mailMode === 'durable') {
        const durable = config.betterAuth.durableMail;
        if (durable === undefined)
          throw new TypeError('Durable authentication mail is not configured');
        authenticationMailStore = createAuthenticationMailEnqueueStore(
          databaseConfig,
          runtime,
        );
        mail = new DurableAuthenticationMail(
          authenticationMailStore,
          createApplicationSecretEnvelope(durable.encryption),
          durable.fromEmail,
        );
      }
      mail ??= disabledAuthenticationMail;
      betterAuthRuntime = createBetterAuthRuntime({
        baseUrl: publicOrigin,
        secret: config.betterAuth.secret,
        database: databaseConfig,
        secureCookies: config.session.secureCookie,
        sessionTtlSeconds: Math.floor(config.session.ttlMillis / 1_000),
        trustedOrigins: [publicOrigin],
        mail,
        socialProviders: config.betterAuth.providers,
        ...(config.oidc === undefined || transactions === undefined
          ? {}
          : {
              legacyOidc: {
                configuration: {
                  issuer: config.oidc.issuer,
                  authorizationEndpoint: config.oidc.authorizationEndpoint,
                  clientId: config.oidc.clientId,
                  redirectUri: new URL(
                    '/v1/auth/legacy-migration/oidc/callback',
                    publicOrigin,
                  ).toString(),
                  scopes: config.oidc.scopes,
                  transactionTtlMillis: config.oidc.transactionTtlMillis,
                },
                transactions,
                provider:
                  overrides.provider ??
                  new GenericOidcProviderAdapter({
                    issuer: config.oidc.issuer,
                    authorizationEndpoint: config.oidc.authorizationEndpoint,
                    tokenEndpoint: config.oidc.tokenEndpoint,
                    jwksUri: config.oidc.jwksUri,
                    redirectUri: new URL(
                      '/v1/auth/legacy-migration/oidc/callback',
                      publicOrigin,
                    ).toString(),
                    clientId: config.oidc.clientId,
                    ...(config.oidc.clientSecret === undefined
                      ? {}
                      : { clientSecret: config.oidc.clientSecret }),
                    allowedAlgorithms: [...config.oidc.allowedAlgorithms],
                    timeoutMillis: config.oidc.timeoutMillis,
                    allowInsecureHttpForTests:
                      config.oidc.allowInsecureHttpForTests,
                  }),
              },
            }),
      });
    }
    const acquiredIdentityDatabase = identityDatabase;
    const acquiredTransactionDatabase = transactionDatabase;
    let closePromise: Promise<void> | undefined;

    return Object.freeze({
      dependencies: Object.freeze({
        config: Object.freeze({
          allowGenericOidcLogin: config.betterAuth === undefined,
          ...(config.publicWebOrigin === undefined
            ? {}
            : { publicWebOrigin: config.publicWebOrigin }),
          ...(config.oidc === undefined
            ? {}
            : {
                oidc: Object.freeze({
                  issuer: config.oidc.issuer,
                  authorizationEndpoint: config.oidc.authorizationEndpoint,
                  clientId: config.oidc.clientId,
                  ...(config.oidc.callbackLandingPath === undefined
                    ? {}
                    : { callbackLandingPath: config.oidc.callbackLandingPath }),
                  redirectUri: config.oidc.redirectUri,
                  scopes: config.oidc.scopes,
                  transactionTtlMillis: config.oidc.transactionTtlMillis,
                }),
              }),
          session: config.session,
        }),
        ...(provider === undefined ? {} : { provider }),
        ...(transactions === undefined ? {} : { transactions }),
        persistence,
        authorization: persistence,
        ...(invitationEncryption === undefined
          ? {}
          : { invitationTokens: invitationEncryption }),
        ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
        telemetry,
        ...(betterAuthRuntime === undefined
          ? {}
          : {
              sessions: new BetterAuthSessionService(betterAuthRuntime, {
                secure: config.session.secureCookie,
                sameSite: config.session.sameSite,
                ttlSeconds: Math.floor(config.session.ttlMillis / 1_000),
              }),
            }),
      }),
      ...(betterAuthRuntime === undefined
        ? {}
        : { betterAuth: betterAuthRuntime }),
      close: (): Promise<void> => {
        closePromise ??= closeIdentityResources(
          acquiredIdentityDatabase,
          acquiredTransactionDatabase,
          betterAuthRuntime,
          authenticationMailStore,
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectIdentityCloseFailures(
      identityDatabase,
      transactionDatabase,
      betterAuthRuntime,
      authenticationMailStore,
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Identity runtime construction and cleanup failed',
      );
    throw error;
  }
}

async function countLegacyOnlyUsers(config: DatabaseConfig): Promise<number> {
  const pool = new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: 1,
  });
  try {
    const result = await pool.query<{ affected: number }>(
      `select count(*)::integer affected
         from app.users users
        where users.status='active'
          and exists (
            select 1 from app.auth_identities identity
             where identity.user_id=users.id
          )
          and not exists (
            select 1 from app.auth_accounts account
             where account.user_id=users.id
          )`,
    );
    return result.rows[0]?.affected ?? 0;
  } finally {
    await pool.end();
  }
}

function identityPublicOrigin(config: ApiIdentityConfig): string {
  if (config.publicWebOrigin !== undefined) return config.publicWebOrigin;
  if (config.oidc !== undefined) return new URL(config.oidc.redirectUri).origin;
  throw new TypeError('Identity public web origin is not configured');
}

function productionIdentityTelemetry(): IdentityWorkspaceTelemetry {
  return createIdentityWorkspaceTelemetry({
    meter: metrics.getMeter('@pertexo/api.identity-workspace', '0.0.0'),
    tracer: trace.getTracer('@pertexo/api.identity-workspace', '0.0.0'),
  });
}

async function closeIdentityResources(
  database: IdentityWorkspaceDatabase,
  transactions: DatabaseOidcLoginTransactionStore | undefined,
  betterAuth?: BetterAuthRuntime,
  authenticationMailStore?: AuthenticationMailEnqueueStore,
): Promise<void> {
  const failures = await collectIdentityCloseFailures(
    database,
    transactions,
    betterAuth,
    authenticationMailStore,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Identity resource shutdown failed');
  }
}

async function collectIdentityCloseFailures(
  database: IdentityWorkspaceDatabase | undefined,
  transactions: DatabaseOidcLoginTransactionStore | undefined,
  betterAuth?: BetterAuthRuntime,
  authenticationMailStore?: AuthenticationMailEnqueueStore,
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => betterAuth?.close()),
    Promise.resolve().then(() => authenticationMailStore?.close()),
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
