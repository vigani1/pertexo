import { metrics } from '@opentelemetry/api';
import {
  createScheduleTriggerDatabase,
  type DatabaseConfig,
  type ScheduleTriggerDatabase,
} from '@pertexo/database';

import { ScheduleManagementService } from '../../schedules/service.js';
import { createScheduleTelemetry } from '../../schedules/telemetry.js';

export type ApiScheduleRuntime = Readonly<{
  service: ScheduleManagementService;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export function createApiScheduleRuntime(
  config: DatabaseConfig,
  override?: ScheduleTriggerDatabase,
): ApiScheduleRuntime {
  const database = override ?? createScheduleTriggerDatabase(config);
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
  const telemetry = createScheduleTelemetry({
    count: (operation, outcome) => {
      count.add(1, { operation, outcome });
    },
    duration: (operation, outcome, seconds) => {
      duration.record(seconds, { operation, outcome });
    },
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    service: new ScheduleManagementService(database, telemetry),
    checkReadiness: () => database.checkReadiness(),
    close: () => {
      closePromise ??= database.close();
      return closePromise;
    },
  });
}
