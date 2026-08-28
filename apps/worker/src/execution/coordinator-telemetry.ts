import { metrics, type Meter } from '@opentelemetry/api';

export interface CoordinatorTelemetry {
  scheduleStarted(durationSeconds: number): void;
}

export function createCoordinatorTelemetry(
  meter: Meter = metrics.getMeter('@pertexo/worker.coordinator', '0.0.0'),
): CoordinatorTelemetry {
  const starts = meter.createCounter('pertexo.schedule.start.count', {
    description: 'Scheduled workflow starts by bounded observation outcome',
    unit: '{start}',
  });
  const duration = meter.createHistogram('pertexo.schedule.to_start.duration', {
    description:
      'Duration from the due schedule occurrence to durable run start',
    unit: 's',
  });

  return Object.freeze({
    scheduleStarted: (durationSeconds: number): void => {
      if (!Number.isFinite(durationSeconds)) return;
      if (durationSeconds < 0) {
        starts.add(1, { outcome: 'clock_skew' });
        return;
      }
      duration.record(durationSeconds);
      starts.add(1, { outcome: 'observed' });
    },
  });
}
