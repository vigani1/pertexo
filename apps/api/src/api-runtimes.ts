import {
  createApiCallbackRuntime,
  type ApiCallbackRuntime,
} from './platform/webhooks/callback-runtime.module.js';
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/platform';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { ApiConfig } from './platform/config/api.js';
import {
  createApiConnectionRuntime,
  type ApiConnectionRuntime,
  type ApiConnectionRuntimeOverrides,
} from './platform/connections/connection-runtime.module.js';
import {
  createApiIdentityRuntime,
  type ApiIdentityRuntime,
  type ApiIdentityRuntimeOverrides,
} from './platform/identity/identity-runtime.module.js';
import {
  createApiWorkflowRuntime,
  type ApiWorkflowRuntime,
  type ApiWorkflowRuntimeOverrides,
} from './platform/workflow/workflow-runtime.module.js';
import {
  createApiWebhookRuntime,
  type ApiWebhookRuntime,
} from './platform/webhooks/webhook-runtime.module.js';
import {
  createApiScheduleRuntime,
  type ApiScheduleRuntime,
} from './platform/schedules/schedule-runtime.module.js';
import {
  createApiNotificationRuntime,
  type ApiNotificationRuntime,
} from './platform/notifications/notification-runtime.module.js';
import type { RateLimitConsumer } from './platform/rate-limit/interceptor.js';
import {
  createApiArtifactRuntime,
  type ApiArtifactRuntime,
  type ApiArtifactRuntimeOverrides,
} from './platform/artifacts/artifact-runtime.module.js';

/*
 * The feature runtimes an API process owns: which to create from
 * configuration, which a caller supplied, and how to release them when
 * startup fails.
 */

type ApiApplicationDependencyCore = Readonly<{
  database?: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime;
  callbackRuntime?: ApiCallbackRuntime;
  webhookRuntime?: ApiWebhookRuntime;
  scheduleRuntime?: ApiScheduleRuntime;
  notificationRuntime?: ApiNotificationRuntime;
  rateLimitConsumer?: RateLimitConsumer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

type IdentityRuntimeSource =
  | Readonly<{
      identityRuntime: ApiIdentityRuntime;
      identityOverrides?: never;
    }>
  | Readonly<{
      identityRuntime?: undefined;
      identityOverrides?: ApiIdentityRuntimeOverrides;
    }>;

type ConnectionRuntimeSource =
  | Readonly<{
      connectionRuntime: ApiConnectionRuntime;
      connectionOverrides?: never;
    }>
  | Readonly<{
      connectionRuntime?: undefined;
      connectionOverrides?: ApiConnectionRuntimeOverrides;
    }>;

type WorkflowRuntimeSource =
  | Readonly<{
      workflowRuntime: ApiWorkflowRuntime;
      workflowOverrides?: never;
    }>
  | Readonly<{
      workflowRuntime?: undefined;
      workflowOverrides?: ApiWorkflowRuntimeOverrides;
    }>;

type ArtifactRuntimeSource =
  | Readonly<{
      artifactRuntime: ApiArtifactRuntime;
      artifactOverrides?: never;
    }>
  | Readonly<{
      artifactRuntime?: undefined;
      artifactOverrides?: ApiArtifactRuntimeOverrides;
    }>;

export type ApiApplicationDependencies = ApiApplicationDependencyCore &
  IdentityRuntimeSource &
  ConnectionRuntimeSource &
  WorkflowRuntimeSource &
  ArtifactRuntimeSource;

export async function acquireApiRuntimes(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<ApiRuntimeSet> {
  const runtimes: ApiRuntimeResources = {
    callbackRuntime: undefined,
    artifactRuntime: undefined,
    connectionRuntime: undefined,
    databaseRuntime: undefined,
    identityRuntime: undefined,
    notificationRuntime: undefined,
    scheduleRuntime: undefined,
    webhookRuntime: undefined,
    workflowRuntime: undefined,
  };
  try {
    await acquireIdentityWorkflows(config, dependencies, runtimes);
    await acquireFeatureRuntimes(config, dependencies, runtimes);
  } catch (error: unknown) {
    const cleanupErrors = await cleanupApiRuntimes(runtimes);
    throwStartupFailure(error, cleanupErrors);
  }
  return runtimes;
}

interface ApiRuntimeResources {
  callbackRuntime: ApiCallbackRuntime | undefined;
  artifactRuntime: ApiArtifactRuntime | undefined;
  connectionRuntime: ApiConnectionRuntime | undefined;
  databaseRuntime: DatabaseRuntime | undefined;
  identityRuntime: ApiIdentityRuntime | undefined;
  notificationRuntime: ApiNotificationRuntime | undefined;
  scheduleRuntime: ApiScheduleRuntime | undefined;
  webhookRuntime: ApiWebhookRuntime | undefined;
  workflowRuntime: ApiWorkflowRuntime | undefined;
}

type ApiRuntimeSet = Readonly<ApiRuntimeResources>;

export async function cleanupApiRuntimes(
  runtimes: ApiRuntimeSet,
): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(
    [
      runtimes.callbackRuntime,
      runtimes.identityRuntime,
      runtimes.workflowRuntime,
      runtimes.connectionRuntime,
      runtimes.webhookRuntime,
      runtimes.scheduleRuntime,
      runtimes.notificationRuntime,
      runtimes.artifactRuntime,
      runtimes.databaseRuntime,
    ].map((runtime) => Promise.resolve().then(() => runtime?.close())),
  );
  const cleanupErrors: unknown[] = [];
  for (const result of results)
    if (result.status === 'rejected')
      cleanupErrors.push(result.reason as unknown);
  return cleanupErrors;
}

export function throwStartupFailure(
  startupError: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (cleanupErrors.length === 0) throw startupError;
  const flattened = cleanupErrors.flatMap((cleanupError) => {
    if (!(cleanupError instanceof AggregateError)) return [cleanupError];
    const nested: unknown = (cleanupError as { errors: unknown }).errors;
    return Array.isArray(nested)
      ? nested.map((failure: unknown) => failure)
      : [cleanupError];
  });
  throw new AggregateError(
    [startupError, ...flattened],
    'API startup and cleanup did not complete cleanly',
  );
}

export function assertValidRuntimeSources(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): void {
  const unchecked = dependencies as ApiApplicationDependencyCore & {
    identityRuntime?: ApiIdentityRuntime;
    identityOverrides?: ApiIdentityRuntimeOverrides;
    connectionRuntime?: ApiConnectionRuntime;
    connectionOverrides?: ApiConnectionRuntimeOverrides;
    workflowRuntime?: ApiWorkflowRuntime;
    workflowOverrides?: ApiWorkflowRuntimeOverrides;
    artifactRuntime?: ApiArtifactRuntime;
    artifactOverrides?: ApiArtifactRuntimeOverrides;
  };
  assertExclusiveRuntime(
    'identity',
    unchecked.identityRuntime,
    unchecked.identityOverrides,
  );
  assertExclusiveRuntime(
    'artifact',
    unchecked.artifactRuntime,
    unchecked.artifactOverrides,
  );
  assertExclusiveRuntime(
    'connection',
    unchecked.connectionRuntime,
    unchecked.connectionOverrides,
  );
  assertExclusiveRuntime(
    'workflow',
    unchecked.workflowRuntime,
    unchecked.workflowOverrides,
  );

  const identityAvailable =
    unchecked.identityRuntime !== undefined || config.identity !== undefined;
  if (
    unchecked.identityOverrides !== undefined &&
    config.identity === undefined
  )
    throw new TypeError(
      'identity overrides require configured identity runtime creation',
    );
  if (
    unchecked.connectionOverrides !== undefined &&
    (config.connections === undefined || !identityAvailable)
  )
    throw new TypeError(
      'connection overrides require configured connection runtime creation',
    );
  if (unchecked.workflowOverrides !== undefined && !identityAvailable)
    throw new TypeError(
      'workflow overrides require available identity runtime creation',
    );
  if (
    unchecked.artifactOverrides !== undefined &&
    (config.artifacts === undefined || !identityAvailable)
  )
    throw new TypeError(
      'artifact overrides require configured artifact runtime creation',
    );
  if (!identityAvailable) {
    const featureRuntimeAvailable =
      unchecked.connectionRuntime !== undefined ||
      unchecked.workflowRuntime !== undefined ||
      unchecked.webhookRuntime !== undefined ||
      unchecked.scheduleRuntime !== undefined ||
      unchecked.notificationRuntime !== undefined ||
      unchecked.artifactRuntime !== undefined;
    if (featureRuntimeAvailable)
      throw new TypeError(
        'feature runtimes require an available identity runtime',
      );
  }
}

function assertExclusiveRuntime(
  feature: string,
  runtime: unknown,
  overrides: unknown,
): void {
  if (runtime !== undefined && overrides !== undefined)
    throw new TypeError(
      `${feature} runtime cannot be provided with ${feature} overrides`,
    );
}

async function acquireIdentityWorkflows(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
  runtimes: ApiRuntimeResources,
): Promise<void> {
  runtimes.databaseRuntime = dependencies.databaseRuntime;
  if (
    runtimes.databaseRuntime === undefined &&
    dependencies.database === undefined
  )
    runtimes.databaseRuntime = createDatabaseRuntime(config.database, {
      role: 'api',
    });

  runtimes.identityRuntime = dependencies.identityRuntime;
  if (runtimes.identityRuntime === undefined && config.identity !== undefined)
    runtimes.identityRuntime = await createApiIdentityRuntime(
      config.identity,
      config.database,
      dependencies.identityOverrides,
      runtimes.databaseRuntime,
    );

  runtimes.workflowRuntime = dependencies.workflowRuntime;
  if (
    runtimes.workflowRuntime === undefined &&
    runtimes.identityRuntime !== undefined
  )
    runtimes.workflowRuntime = await createApiWorkflowRuntime(
      config.database,
      runtimes.identityRuntime,
      {
        redisUrl: config.redisUrl,
        overrides: dependencies.workflowOverrides,
        runtime: runtimes.databaseRuntime,
        codeSettings: config.codeSettings,
      },
    );

  runtimes.connectionRuntime = dependencies.connectionRuntime;
  if (
    runtimes.connectionRuntime === undefined &&
    runtimes.identityRuntime !== undefined &&
    config.connections !== undefined
  ) {
    if (config.identity === undefined)
      throw new Error('Connections require application identity configuration');
    runtimes.connectionRuntime = await createApiConnectionRuntime(
      config.connections,
      config.database,
      {
        identityRuntime: runtimes.identityRuntime,
        applicationSecret: config.identity.betterAuth.secret,
        overrides: dependencies.connectionOverrides,
        runtime: runtimes.databaseRuntime,
      },
    );
  }
}

async function acquireFeatureRuntimes(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
  runtimes: ApiRuntimeResources,
): Promise<void> {
  runtimes.callbackRuntime = dependencies.callbackRuntime;
  if (
    runtimes.callbackRuntime === undefined &&
    (dependencies.database === undefined || config.callbacks !== undefined)
  )
    runtimes.callbackRuntime = await createApiCallbackRuntime(
      config,
      runtimes.databaseRuntime,
    );
  runtimes.webhookRuntime = dependencies.webhookRuntime;
  if (
    runtimes.webhookRuntime === undefined &&
    runtimes.identityRuntime !== undefined &&
    config.webhooks !== undefined
  )
    runtimes.webhookRuntime = await createApiWebhookRuntime(
      config.webhooks,
      config.database,
      { databaseOverride: undefined, runtime: runtimes.databaseRuntime },
    );

  runtimes.scheduleRuntime = dependencies.scheduleRuntime;
  if (
    runtimes.scheduleRuntime === undefined &&
    runtimes.identityRuntime !== undefined &&
    dependencies.database === undefined
  )
    runtimes.scheduleRuntime = await createApiScheduleRuntime(
      config.database,
      undefined,
      runtimes.databaseRuntime,
    );

  runtimes.notificationRuntime = dependencies.notificationRuntime;
  if (
    runtimes.notificationRuntime === undefined &&
    runtimes.identityRuntime !== undefined &&
    dependencies.database === undefined
  )
    runtimes.notificationRuntime = createApiNotificationRuntime(
      config.database,
      config.redisUrl,
      {
        overrides: {},
        runtime: runtimes.databaseRuntime,
        mail: config.identity?.betterAuth.durableMail,
      },
    );

  runtimes.artifactRuntime = dependencies.artifactRuntime;
  if (
    runtimes.artifactRuntime === undefined &&
    runtimes.identityRuntime !== undefined &&
    config.artifacts !== undefined
  )
    runtimes.artifactRuntime = createApiArtifactRuntime(
      config.artifacts,
      config.database,
      {
        identityRuntime: runtimes.identityRuntime,
        overrides: dependencies.artifactOverrides,
        databaseRuntime: runtimes.databaseRuntime,
      },
    );
}
