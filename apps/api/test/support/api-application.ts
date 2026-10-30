import type { WorkspaceDatabase } from '@pertexo/database/testing';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import {
  cleanupApiRuntimes,
  throwStartupFailure,
  type ApiApplicationDependencies,
} from '../../src/api-runtimes.js';
import { assembleApiApplication } from '../../src/app.js';
import type { ApiRuntimeSet } from '../../src/platform/application/contract.js';
import { createApiArtifactRuntime } from '../../src/platform/artifacts/runtime.module.js';
import type { ApiConfig } from '../../src/platform/config/api.js';
import type { RateLimitConsumer } from '../../src/platform/rate-limit/interceptor.js';
import type { ApiRateLimit } from '../../src/platform/rate-limit/module.js';
import { createApiCallbackRuntime } from '../../src/platform/webhooks/callback-runtime.module.js';
import { createApiWorkflowRuntime } from '../../src/platform/workflow/runtime.module.js';

export type TestApiParts = ApiApplicationDependencies &
  Omit<ApiRuntimeSet, 'database' | 'rateLimit'> &
  Readonly<{
    database: WorkspaceDatabase;
    /** Replaces admission only; export slots stay on the real service. */
    rateLimitConsumer?: RateLimitConsumer;
  }>;

/**
 * The real application from the parts a test supplies. Workflows, callbacks
 * and artifacts it leaves out get their real runtime when configuration and
 * identity allow; the application owns everything once it has started.
 */
export async function createTestApiApplication(
  config: ApiConfig,
  { logger, telemetry, database, rateLimitConsumer, ...supplied }: TestApiParts,
) {
  const rateLimit = testRateLimit(config, rateLimitConsumer);
  const runtimes: {
    -readonly [Key in keyof ApiRuntimeSet]: ApiRuntimeSet[Key];
  } = { ...supplied, database, rateLimit };
  try {
    const identityRuntime = supplied.identityRuntime;
    if (identityRuntime !== undefined) {
      runtimes.workflowRuntime ??= await createApiWorkflowRuntime(
        config.database,
        identityRuntime,
        { redisUrl: config.redisUrl, codeSettings: config.codeSettings },
      );
      if (config.artifacts !== undefined)
        runtimes.artifactRuntime ??= createApiArtifactRuntime(
          config.artifacts,
          config.database,
          { identityRuntime },
        );
    }
    if (config.callbacks !== undefined)
      runtimes.callbackRuntime ??= await createApiCallbackRuntime(config);
  } catch (error: unknown) {
    throwStartupFailure(error, await cleanupApiRuntimes(runtimes));
  }
  return assembleApiApplication(config, { logger, telemetry }, runtimes);
}

function testRateLimit(
  config: ApiConfig,
  consumer: RateLimitConsumer | undefined,
): ApiRateLimit {
  const runtime = new RedisRateLimitRuntime(config.redisUrl);
  if (consumer === undefined) return runtime;
  return {
    consume: (decision) => consumer.consume(decision),
    acquireExclusiveSlot: (key, ttl) => runtime.acquireExclusiveSlot(key, ttl),
    close: () => runtime.close(),
  };
}
