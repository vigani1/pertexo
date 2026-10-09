import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createIdentityWorkspaceDatabase,
  type IdentityWorkspaceDatabase,
} from '@pertexo/database/tenant-access';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
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
import type { IdentityClock } from '../../identity/index.js';
import type { ApiIdentityConfig } from '../config/identity-config.js';
import { composeBetterAuthRuntime } from './better-auth-composition.js';

export type ApiIdentityRuntime = Readonly<{
  dependencies: IdentityWorkspaceDependencies;
  betterAuth: BetterAuthRuntime;
  close(): Promise<void>;
}>;

export type ApiIdentityRuntimeOverrides = Readonly<{
  clock?: IdentityClock;
  authenticationMail?: AuthenticationMail;
  persistence?: Readonly<{
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
 * injection seams for real-database integration tests.
 */
export async function createApiIdentityRuntime(
  config: ApiIdentityConfig,
  databaseConfig: DatabaseConfig,
  overrides: ApiIdentityRuntimeOverrides = {},
  runtime?: DatabaseRuntime,
): Promise<ApiIdentityRuntime> {
  const persistenceOverrides = overrides.persistence ?? {};
  const invitationEncryption =
    config.invitationTokenEncryption === undefined
      ? undefined
      : createApplicationSecretEnvelope(config.invitationTokenEncryption);
  const resources = new IdentityResourceScope();
  try {
    const identityDatabase = resources.own(
      persistenceOverrides.database ??
        (
          persistenceOverrides.databaseFactory ??
          createIdentityWorkspaceDatabase
        )(databaseConfig, runtime),
    );
    const persistence = new DatabaseIdentityWorkspaceAdapter(identityDatabase);
    const betterAuth = composeBetterAuthRuntime({
      config,
      databaseConfig,
      runtime,
      authenticationMail: overrides.authenticationMail,
      acquire: (resource) => resources.own(resource),
    });
    let closePromise: Promise<void> | undefined;

    return Object.freeze({
      dependencies: identityDependencies({
        config,
        persistence,
        invitationEncryption,
        clock: overrides.clock,
        telemetry: identityTelemetry(overrides.telemetry),
        betterAuth,
      }),
      betterAuth,
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

/** Better Auth is the one browser-session authority (ADR 039). */
function identityDependencies(
  input: Readonly<{
    config: ApiIdentityConfig;
    persistence: DatabaseIdentityWorkspaceAdapter;
    invitationEncryption: ApplicationSecretEnvelope | undefined;
    clock: IdentityClock | undefined;
    telemetry: IdentityWorkspaceTelemetry;
    betterAuth: BetterAuthRuntime;
  }>,
): IdentityWorkspaceDependencies {
  const { config } = input;
  return Object.freeze({
    config: Object.freeze({
      publicWebOrigin: config.publicWebOrigin,
      session: config.session,
    }),
    persistence: input.persistence,
    authorization: input.persistence,
    ...(input.invitationEncryption === undefined
      ? {}
      : { invitationTokens: input.invitationEncryption }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    telemetry: input.telemetry,
    sessions: new BetterAuthSessionService(input.betterAuth, {
      secure: config.session.secureCookie,
      sameSite: config.session.sameSite,
      ttlSeconds: Math.floor(config.session.ttlMillis / 1_000),
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
