import {
  createApiApplication,
  type ApiApplicationDependencies,
} from '../../src/app.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiScheduleRuntime } from '../../src/platform/schedules/schedule-runtime.module.js';
import type { FixtureResourceOwner } from './fixture-resource-owner.js';

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
  const application = owner.acquire(
    'API application',
    await createApiApplication(config, {
      ...dependencies,
      ...(scheduleRuntime === undefined ? {} : { scheduleRuntime }),
    }),
    (app) => app.close(),
  );
  // The application owns supplied runtimes after successful construction.
  // Before that point, fixture cleanup still owns partial acquisition/readiness.
  if (scheduleRuntime !== undefined) owner.transfer(scheduleRuntime);
  return application;
}
