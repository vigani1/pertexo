import { createApiCallbackRuntime } from './platform/webhooks/callback-runtime.module.js';
import {
  createDatabaseRuntime,
  createWorkspaceDatabase,
} from '@pertexo/database/platform';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import type { ApiConfig } from './platform/config/api.js';
import { createApiConnectionRuntime } from './platform/connections/runtime.module.js';
import { createApiIdentityRuntime } from './platform/identity/runtime.module.js';
import { createApiWorkflowRuntime } from './platform/workflow/runtime.module.js';
import { createApiWebhookRuntime } from './platform/webhooks/runtime.module.js';
import { createApiScheduleRuntime } from './platform/schedules/runtime.module.js';
import { createApiNotificationRuntime } from './platform/notifications/runtime.module.js';

import { createApiArtifactRuntime } from './platform/artifacts/runtime.module.js';
import type {
  ApiApplicationDependencies,
  ApiRuntimeSet,
} from './platform/application/contract.js';
import type { ApiRateLimit } from './platform/rate-limit/module.js';

type ApiRuntimeResources = {
  -readonly [Key in keyof ApiRuntimeSet]?: ApiRuntimeSet[Key] | undefined;
};

export { type ApiApplicationDependencies } from './platform/application/contract.js';
export { assertValidRuntimeSources } from './platform/application/sources.js';
export async function acquireApiRuntimes(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): Promise<ApiRuntimeSet> {
  const runtimes: ApiRuntimeResources = {};
  try {
    await acquireIdentityWorkflows(config, dependencies, runtimes);
    await acquireFeatureRuntimes(config, dependencies, runtimes);
    const { database, rateLimit } = runtimes;
    if (database === undefined || rateLimit === undefined)
      throw new Error('API runtime composition is incomplete');
    return { ...runtimes, database, rateLimit };
  } catch (error: unknown) {
    const cleanupErrors = await cleanupApiRuntimes(runtimes);
    throwStartupFailure(error, cleanupErrors);
  }
}

export async function cleanupApiRuntimes(
  runtimes: ApiRuntimeResources,
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
      runtimes.rateLimit,
      runtimes.database,
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
  runtimes.database =
    dependencies.database ??
    createWorkspaceDatabase(
      config.database,
      runtimes.databaseRuntime === undefined
        ? {}
        : { runtime: runtimes.databaseRuntime },
    );
  runtimes.rateLimit = acquireRateLimit(config, dependencies);

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

function acquireRateLimit(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
): ApiRateLimit {
  const runtime = new RedisRateLimitRuntime(config.redisUrl);
  if (dependencies.rateLimitConsumer === undefined) return runtime;
  return {
    consume: dependencies.rateLimitConsumer.consume.bind(
      dependencies.rateLimitConsumer,
    ),
    acquireExclusiveSlot: runtime.acquireExclusiveSlot.bind(runtime),
    close: runtime.close.bind(runtime),
  };
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
      {
        logger: dependencies.logger,
        databaseOverride: undefined,
        runtime: runtimes.databaseRuntime,
      },
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
