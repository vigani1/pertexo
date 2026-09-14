import { metrics } from '@opentelemetry/api';
import {
  createScheduleTriggerDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type ScheduleTriggerDatabase,
} from '@pertexo/database/api';

import { ScheduleManagementService } from '../../schedules/service.js';
import {
  createScheduleTelemetry,
  type ScheduleTelemetry,
} from '../../schedules/telemetry.js';

export type ApiScheduleRuntime = Readonly<{
  service: ScheduleManagementService;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export type ApiScheduleRuntimeFactories = Readonly<{
  database?: typeof createScheduleTriggerDatabase;
  telemetry?: () => ScheduleTelemetry;
}>;

export async function createApiScheduleRuntime(
  config: DatabaseConfig,
  override?: ScheduleTriggerDatabase,
  runtime?: DatabaseRuntime,
  factories: ApiScheduleRuntimeFactories = {},
): Promise<ApiScheduleRuntime> {
  let database: ScheduleTriggerDatabase | undefined;
  try {
    database =
      override ??
      (factories.database ?? createScheduleTriggerDatabase)(config, runtime);
    const telemetry =
      factories.telemetry?.() ?? createProductionScheduleTelemetry();
    const acquiredDatabase = database;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      service: new ScheduleManagementService(acquiredDatabase, telemetry),
      checkReadiness: () => acquiredDatabase.checkReadiness(),
      close: () => {
        closePromise ??= Promise.resolve().then(() => acquiredDatabase.close());
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectScheduleCloseFailures(database);
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Schedule runtime construction and cleanup failed',
      );
    throw error;
  }
}

function createProductionScheduleTelemetry(): ScheduleTelemetry {
  const meter = metrics.getMeter('@pertexo/api.schedules', '0.0.0');
  const count = meter.createCounter('pertexo.schedule.operation.count', {
    description: 'Completed schedule operations by bounded operation/outcome',
  });
  const duration = meter.createHistogram(
    'pertexo.schedule.operation.duration',
    {
      description: 'Schedule operation duration by bounded operation/outcome',
      unit: 's',
    },
  );
  return createScheduleTelemetry({
    count: (operation, outcome) => {
      count.add(1, { operation, outcome });
    },
    duration: (operation, outcome, seconds) => {
      duration.record(seconds, { operation, outcome });
    },
  });
}

async function collectScheduleCloseFailures(
  database: ScheduleTriggerDatabase | undefined,
): Promise<unknown[]> {
  const result = await Promise.allSettled([
    Promise.resolve().then(() => database?.close()),
  ]);
  return result.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
}
