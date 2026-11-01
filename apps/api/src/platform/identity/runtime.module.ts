import { DirectoryManagementModule } from '../../authentication/federation/provisioning/management/module.js';
import {
  createDirectoryStore,
  type DirectoryStore,
  createIdentityWorkspaceDatabase,
  createFederationManagementStore,
  createApiTokenDatabase,
} from '@pertexo/core/tenant-access';
import { FederationManagementModule } from '../../authentication/federation/management/module.js';
import { FederationManagementService } from '../../authentication/federation/management/service.js';
import { federationSecretContext } from '../../authentication/federation/protocol/oidc.js';
import {
  ApiTokenModule,
  type ApiTokenDependencies,
} from '../../api-tokens/module.js';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
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
} from '../../authentication/index.js';
import {
  DatabaseIdentityWorkspaceAdapter,
  IdentityWorkspaceModule,
  createIdentityWorkspaceTelemetry,
  type IdentityWorkspaceTelemetry,
  type IdentityWorkspaceDependencies,
} from '../../workspaces/index.js';
import type { ApiIdentityConfig } from '../config/identity.js';
import { composeBetterAuthRuntime } from './better-auth-composition.js';

export type ApiIdentityRuntime = Readonly<{
  dependencies: IdentityWorkspaceDependencies;
  betterAuth: BetterAuthRuntime;
  automation: ApiTokenDependencies;
  federation: FederationManagementService;
  directory: DirectoryStore;
  close(): Promise<void>;
}>;

type ClosableResource = Readonly<{ close(): unknown }>;

/**
 * Composes the server-only identity infrastructure. Authentication mail is the
 * one outside service a caller may replace; the local sink cannot be read back.
 */
export async function createApiIdentityRuntime(
  config: ApiIdentityConfig,
  databaseConfig: DatabaseConfig,
  {
    runtime,
    authenticationMail,
  }: Readonly<{
    runtime?: DatabaseRuntime;
    authenticationMail?: AuthenticationMail;
  }> = {},
): Promise<ApiIdentityRuntime> {
  const invitationEncryption =
    config.invitationTokenEncryption === undefined
      ? undefined
      : createApplicationSecretEnvelope(config.invitationTokenEncryption);
  const resources = new IdentityResourceScope();
  try {
    const identityDatabase = resources.own(
      createIdentityWorkspaceDatabase(databaseConfig, runtime),
    );
    const tokenDatabase = resources.own(
      createApiTokenDatabase(databaseConfig, runtime),
    );
    const directory = resources.own(
      createDirectoryStore(databaseConfig, runtime),
    );
    const federationStore = resources.own(
      createFederationManagementStore(databaseConfig, runtime),
    );
    const federationEnvelope =
      config.federationEncryption === undefined
        ? undefined
        : createApplicationSecretEnvelope(config.federationEncryption);
    await federationStore.checkStoredSecrets(
      (sealed, workspaceId, providerId) => {
        try {
          if (federationEnvelope === undefined)
            throw new Error('Missing organization key');
          federationEnvelope.open(
            sealed,
            federationSecretContext(workspaceId, providerId),
          );
        } catch {
          throw new Error(
            'Organization sign-in secrets cannot be opened. Configure AUTH_FEDERATION_KEY, its version and required previous keys before starting the API.',
          );
        }
      },
    );
    const federation = new FederationManagementService(
      federationStore,
      federationEnvelope,
      {
        secret: config.betterAuth.secret,
        publicOrigin: config.publicWebOrigin,
        secureCookies: config.session.secureCookie,
      },
    );
    const persistence = new DatabaseIdentityWorkspaceAdapter(identityDatabase);
    const betterAuth = composeBetterAuthRuntime({
      config,
      databaseConfig,
      runtime,
      authenticationMail,
      acquire: (resource) => resources.own(resource),
    });
    let closePromise: Promise<void> | undefined;

    return Object.freeze({
      dependencies: identityDependencies({
        config,
        persistence,
        invitationEncryption,
        telemetry: productionIdentityTelemetry(),
        betterAuth,
      }),
      betterAuth,
      federation,
      directory,
      automation: {
        database: tokenDatabase,
        enabled: config.automationTokensEnabled ?? false,
        clock: { now: () => new Date() },
      },
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
  public static register(
    runtime: ApiIdentityRuntime,
    admission: DynamicModule,
  ): DynamicModule {
    const feature = IdentityWorkspaceModule.register(runtime.dependencies);
    const tokens = ApiTokenModule.register(
      feature,
      admission,
      runtime.automation,
    );
    return {
      module: IdentityRuntimeModule,
      imports: [
        feature,
        tokens,
        DirectoryManagementModule.register(
          runtime.directory,
          feature,
          admission,
        ),
        FederationManagementModule.register(
          runtime.federation,
          feature,
          admission,
        ),
      ],
      exports: [IdentityWorkspaceModule, ApiTokenModule],
    };
  }
}
