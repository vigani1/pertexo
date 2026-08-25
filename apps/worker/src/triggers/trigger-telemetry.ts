import { metrics } from '@opentelemetry/api';
import type { ScanDueSchedulesResult } from '@pertexo/database';

export interface TriggerRuntimeTelemetry {
  reconciliationCompleted(outcome: 'succeeded' | 'failed'): void;
  scanCompleted(result: ScanDueSchedulesResult, durationSeconds: number): void;
  scanFailed(durationSeconds: number): void;
}

export function createTriggerRuntimeTelemetry(): TriggerRuntimeTelemetry {
  const meter = metrics.getMeter('@pertexo/worker.triggers', '0.0.0');
  const scans = meter.createCounter('pertexo.schedule.scan.count', {
    description: 'Schedule scans by bounded outcome',
  });
  const reconciliation = meter.createCounter(
    'pertexo.trigger.reconciliation.count',
    { description: 'Trigger reconciliation deliveries by bounded outcome' },
  );
  const occurrences = meter.createCounter('pertexo.schedule.occurrence.count', {
    description: 'Schedule occurrence decisions by bounded outcome',
  });
  const duration = meter.createHistogram('pertexo.schedule.scan.duration', {
    description: 'Schedule scan duration by bounded outcome',
    unit: 's',
  });
  const lag = meter.createHistogram('pertexo.schedule.lag', {
    description: 'Maximum due occurrence lag observed by a schedule scan',
    unit: 's',
  });
  const health = meter.createCounter('pertexo.trigger.health.count', {
    description: 'Trigger runtime health observations by bounded status',
  });
  const telemetry: TriggerRuntimeTelemetry = {
    reconciliationCompleted: (outcome: 'succeeded' | 'failed') => {
      reconciliation.add(1, { outcome });
    },
    scanCompleted: (
      result: ScanDueSchedulesResult,
      durationSeconds: number,
    ) => {
      scans.add(1, { outcome: 'succeeded' });
      duration.record(durationSeconds, { outcome: 'succeeded' });
      lag.record(result.maxLagSeconds);
      occurrences.add(result.accepted, { outcome: 'accepted' });
      occurrences.add(result.deferred, { outcome: 'deferred' });
      occurrences.add(result.skipped, { outcome: 'skipped' });
      health.add(1, { status: result.deferred > 0 ? 'throttled' : 'healthy' });
    },
    scanFailed: (durationSeconds: number) => {
      scans.add(1, { outcome: 'failed' });
      duration.record(durationSeconds, { outcome: 'failed' });
      health.add(1, { status: 'degraded' });
    },
  };
  return Object.freeze(telemetry);
}
