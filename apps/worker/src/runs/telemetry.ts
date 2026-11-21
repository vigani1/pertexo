import type { RunAdvanceResult } from '@pertexo/core/runs';
import { metrics, type Meter } from '@opentelemetry/api';

type InlineAttemptMeasurement = NonNullable<
  Extract<RunAdvanceResult, { kind: 'committed' }>['inline']
>['metrics'][number];

export interface CoordinatorTelemetry {
  scheduleStarted(durationSeconds: number): void;
  inlineAttempt?(measurement: InlineAttemptMeasurement): void;
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

  const inlineAttemptDuration = meter.createHistogram(
    'pertexo.workflow.step.duration',
    {
      description: 'Committed inline workflow step attempts by outcome',
      unit: 'ms',
    },
  );

  return Object.freeze({
    inlineAttempt({ durationMillis, outcome }: InlineAttemptMeasurement): void {
      inlineAttemptDuration.record(durationMillis, { outcome });
    },
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
