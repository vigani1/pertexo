import { randomUUID } from 'node:crypto';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import {
  createApiApplication,
  type ApiApplicationDependencies,
} from '../../../src/app.js';
import type { ApiConfig } from '../../../src/platform/config/api-config.js';
import { createApiScheduleRuntime } from '../../../src/platform/schedules/schedule-runtime.module.js';
import type { FixtureResourceOwner } from '../../browser/harness/resource-owner.js';

/** The real API composition used by the disposable Better Auth fixture. */
export async function createBetterAuthFixtureApplication(
  config: ApiConfig,
  dependencies: ApiApplicationDependencies,
  owner: FixtureResourceOwner,
  schedules = false,
  createSchedules = createApiScheduleRuntime,
) {
  const scheduleRuntime = schedules
    ? owner.acquire(
        'schedule runtime',
        await createSchedules(config.database),
        (runtime) => runtime.close(),
      )
    : undefined;
  await scheduleRuntime?.checkReadiness();
  const rateLimitConsumer =
    dependencies.rateLimitConsumer ??
    fixtureRateLimiter(config.redisUrl, owner);
  const application = owner.acquire(
    'API application',
    await createApiApplication(config, {
      ...dependencies,
      rateLimitConsumer,
      ...(scheduleRuntime === undefined ? {} : { scheduleRuntime }),
    }),
    (app) => app.close(),
  );
  // The application owns supplied runtimes after successful construction.
  // Before that point, fixture cleanup still owns partial acquisition/readiness.
  if (scheduleRuntime !== undefined) owner.transfer(scheduleRuntime);
  return application;
}

function fixtureRateLimiter(redisUrl: string, owner: FixtureResourceOwner) {
  const namespace = randomUUID();
  const runtime = owner.acquire(
    'fixture rate limiter',
    new RedisRateLimitRuntime(redisUrl),
    (limiter) => limiter.close(),
  );
  return {
    consume: (decision: Parameters<RedisRateLimitRuntime['consume']>[0]) =>
      runtime.consume({
        ...decision,
        // Separate fixture applications share Redis and browser origins.
        // Scope counter identities once per application, retaining the real
        // limits, windows, atomic Redis enforcement and fail-closed behavior.
        dimensions: decision.dimensions.map((dimension) => ({
          ...dimension,
          identifier: `${namespace}:${dimension.identifier}`,
        })),
      }),
  };
}
