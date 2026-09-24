import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createIdentityWorkspaceDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type IdentityWorkspaceDatabase,
} from '@pertexo/database/api';
import {
  createApplicationSecretEnvelope,
  type ApplicationSecretEnvelope,
} from '@pertexo/integrations/server';

import {
  BetterAuthSessionService,
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
import {
  assertStandaloneCutoverReady,
  composeBetterAuthRuntime,
  countLegacyOnlyUsers,
} from './better-auth-composition.js';
import {
  adaptTransactionStore,
  genericOidcProvider,
  openOidcTransactionStore,
  type OidcTransactionOverrides,
} from './oidc-runtime.js';

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
  persistence?: OidcTransactionOverrides &
    Readonly<{
      database?: IdentityWorkspaceDatabase;
      databaseFactory?: typeof createIdentityWorkspaceDatabase;
    }>;
  telemetry?: Readonly<{
    value?: IdentityWorkspaceTelemetry;
    factory?: () => IdentityWorkspaceTelemetry;
  }>;
}>;

type ClosableResource = Readonly<{ close(): unknown }>;

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
  assertOidcComposition(config, overrides);
  const provider =
    config.oidc === undefined
      ? undefined
      : (overrides.provider ??
        genericOidcProvider(config.oidc, config.oidc.redirectUri));
  const invitationEncryptionConfig =
    config.invitationTokenEncryption ?? config.secretEncryption;
  const invitationEncryption =
    invitationEncryptionConfig === undefined
      ? undefined
      : createApplicationSecretEnvelope(invitationEncryptionConfig);
  const resources = new IdentityResourceScope();
  try {
    if (config.betterAuth !== undefined && config.oidc === undefined)
      await assertStandaloneCutoverReady(
        overrides.legacyOnlyUserCount ??
          (() => countLegacyOnlyUsers(databaseConfig)),
      );
    const identityDatabase = resources.own(
      persistenceOverrides.database ??
        (
          persistenceOverrides.databaseFactory ??
          createIdentityWorkspaceDatabase
        )(databaseConfig, runtime),
    );
    const transactionDatabase = openOidcTransactionStore(
      config,
      databaseConfig,
      persistenceOverrides,
      runtime,
    );
    if (transactionDatabase !== undefined) resources.own(transactionDatabase);
    const transactions =
      transactionDatabase === undefined
        ? undefined
        : adaptTransactionStore(transactionDatabase);
    const persistence = new DatabaseIdentityWorkspaceAdapter(identityDatabase);
    const telemetry = identityTelemetry(overrides.telemetry);
    const betterAuth =
      config.betterAuth === undefined
        ? undefined
        : composeBetterAuthRuntime({
            config,
            betterAuth: config.betterAuth,
            databaseConfig,
            runtime,
            transactions,
            provider: overrides.provider,
            authenticationMail: overrides.authenticationMail,
            acquire: (resource) => resources.own(resource),
          });
    let closePromise: Promise<void> | undefined;

    return Object.freeze({
      dependencies: identityDependencies({
        config,
        provider,
        transactions,
        persistence,
        invitationEncryption,
        clock: overrides.clock,
        telemetry,
        betterAuth,
      }),
      ...(betterAuth === undefined ? {} : { betterAuth }),
      close: (): Promise<void> => (closePromise ??= resources.close()),
    });
  } catch (error: unknown) {
    const cleanupFailures = await resources.closeFailures();
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Identity runtime construction and cleanup failed',
      );
    throw error;
  }
}

function assertOidcComposition(
  config: ApiIdentityConfig,
  overrides: ApiIdentityRuntimeOverrides,
): void {
  if ((config.oidc === undefined) !== (config.secretEncryption === undefined))
    throw new TypeError(
      'OIDC configuration and transaction encryption must be supplied together',
    );
  if (config.oidc === undefined && overrides.provider !== undefined)
    throw new TypeError('An OIDC provider requires OIDC configuration');
}

function identityTelemetry(
  overrides: ApiIdentityRuntimeOverrides['telemetry'] = {},
): IdentityWorkspaceTelemetry {
  return (
    overrides.value ?? (overrides.factory ?? productionIdentityTelemetry)()
  );
}

function productionIdentityTelemetry(): IdentityWorkspaceTelemetry {
  return createIdentityWorkspaceTelemetry({
    meter: metrics.getMeter('@pertexo/api.identity-workspace', '0.0.0'),
    tracer: trace.getTracer('@pertexo/api.identity-workspace', '0.0.0'),
  });
}

/** Browser-session authority is Better Auth when configured, else OIDC. */
function identityDependencies(
  input: Readonly<{
    config: ApiIdentityConfig;
    provider: OidcProviderPort | undefined;
    transactions: OidcLoginTransactionStore | undefined;
    persistence: DatabaseIdentityWorkspaceAdapter;
    invitationEncryption: ApplicationSecretEnvelope | undefined;
    clock: IdentityClock | undefined;
    telemetry: IdentityWorkspaceTelemetry;
    betterAuth: BetterAuthRuntime | undefined;
  }>,
): IdentityWorkspaceDependencies {
  const { config, betterAuth } = input;
  return Object.freeze({
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
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.transactions === undefined
      ? {}
      : { transactions: input.transactions }),
    persistence: input.persistence,
    authorization: input.persistence,
    ...(input.invitationEncryption === undefined
      ? {}
      : { invitationTokens: input.invitationEncryption }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    telemetry: input.telemetry,
    ...(betterAuth === undefined
      ? {}
      : {
          sessions: new BetterAuthSessionService(betterAuth, {
            secure: config.session.secureCookie,
            sameSite: config.session.sameSite,
            ttlSeconds: Math.floor(config.session.ttlMillis / 1_000),
          }),
        }),
  });
}

/**
 * Owns every acquired identity resource. Closing starts all closers together,
 * newest first, and a synchronous throw cannot skip another owner's close.
 */
class IdentityResourceScope {
  private readonly resources: ClosableResource[] = [];

  public own<Resource extends ClosableResource>(resource: Resource): Resource {
    this.resources.push(resource);
    return resource;
  }

  public async close(): Promise<void> {
    const failures = await this.closeFailures();
    if (failures.length > 0)
      throw new AggregateError(failures, 'Identity resource shutdown failed');
  }

  public async closeFailures(): Promise<unknown[]> {
    const results = await Promise.allSettled(
      [...this.resources]
        .reverse()
        .map((resource) => Promise.resolve().then(() => resource.close())),
    );
    return results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
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
      providers: feature.providers ?? [],
      exports: feature.exports ?? [],
    };
  }
}
