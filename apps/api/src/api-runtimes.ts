import { createApiCallbackRuntime } from './platform/webhooks/callback-runtime.module.js';
import {
  createDatabaseRuntime,
  createWorkspaceDatabase,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import type { ApiConfig } from './platform/config/api.js';
import { createApiConnectionRuntime } from './platform/connections/runtime.module.js';
import {
  createApiIdentityRuntime,
  type ApiIdentityRuntime,
} from './platform/identity/runtime.module.js';
import { createApiWorkflowRuntime } from './platform/workflow/runtime.module.js';
import { createApiWebhookRuntime } from './platform/webhooks/runtime.module.js';
import { createApiScheduleRuntime } from './platform/schedules/runtime.module.js';
import { createApiNotificationRuntime } from './platform/notifications/runtime.module.js';

import { createApiArtifactRuntime } from './platform/artifacts/runtime.module.js';
import type {
  ApiApplicationDependencies,
  ApiRuntimeSet,
} from './platform/application/contract.js';

type ApiRuntimeResources = {
  -readonly [Key in keyof ApiRuntimeSet]?: ApiRuntimeSet[Key] | undefined;
};

export { type ApiApplicationDependencies } from './platform/application/contract.js';
export async function acquireApiRuntimes(
  config: ApiConfig,
  { logger }: Pick<ApiApplicationDependencies, 'logger'>,
): Promise<ApiRuntimeSet> {
  const runtimes: ApiRuntimeResources = {};
  try {
    const databaseRuntime = (runtimes.databaseRuntime = createDatabaseRuntime(
      config.database,
      { role: 'api' },
    ));
    const database = (runtimes.database = createWorkspaceDatabase(
      config.database,
      { runtime: databaseRuntime },
    ));
    const rateLimit = (runtimes.rateLimit = new RedisRateLimitRuntime(
      config.redisUrl,
    ));
    const identityRuntime =
      config.identity === undefined
        ? undefined
        : await acquireIdentityWorkflows(
            config,
            config.identity,
            databaseRuntime,
            runtimes,
          );
    runtimes.callbackRuntime = await createApiCallbackRuntime(
      config,
      databaseRuntime,
    );
    if (identityRuntime !== undefined)
      await acquireFeatureRuntimes(config, logger, {
        identityRuntime,
        databaseRuntime,
        runtimes,
      });
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
  identity: NonNullable<ApiConfig['identity']>,
  databaseRuntime: DatabaseRuntime,
  runtimes: ApiRuntimeResources,
): Promise<ApiIdentityRuntime> {
  const identityRuntime = (runtimes.identityRuntime =
    await createApiIdentityRuntime(identity, config.database, {
      runtime: databaseRuntime,
    }));
  runtimes.workflowRuntime = await createApiWorkflowRuntime(
    config.database,
    identityRuntime,
    {
      redisUrl: config.redisUrl,
      runtime: databaseRuntime,
      codeSettings: config.codeSettings,
    },
  );
  if (config.connections !== undefined)
    runtimes.connectionRuntime = await createApiConnectionRuntime(
      config.connections,
      config.database,
      {
        identityRuntime,
        applicationSecret: identity.betterAuth.secret,
        runtime: databaseRuntime,
      },
    );
  return identityRuntime;
}

async function acquireFeatureRuntimes(
  config: ApiConfig,
  logger: ApiApplicationDependencies['logger'],
  {
    identityRuntime,
    databaseRuntime,
    runtimes,
  }: Readonly<{
    identityRuntime: ApiIdentityRuntime;
    databaseRuntime: DatabaseRuntime;
    runtimes: ApiRuntimeResources;
  }>,
): Promise<void> {
  if (config.webhooks !== undefined)
    runtimes.webhookRuntime = await createApiWebhookRuntime(
      config.webhooks,
      config.database,
      { logger, runtime: databaseRuntime },
    );
  runtimes.scheduleRuntime = await createApiScheduleRuntime(
    config.database,
    databaseRuntime,
  );
  runtimes.notificationRuntime = createApiNotificationRuntime(
    config.database,
    config.redisUrl,
    {
      runtime: databaseRuntime,
      mail: config.identity?.betterAuth.durableMail,
    },
  );
  if (config.artifacts !== undefined)
    runtimes.artifactRuntime = createApiArtifactRuntime(
      config.artifacts,
      config.database,
      { identityRuntime, databaseRuntime },
    );
}
