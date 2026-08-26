import { metrics } from '@opentelemetry/api';
import type {
  RetentionDryRunProcessResult,
  RetentionEnforcementProcessResult,
  PreviewRetentionProcessResult,
  RetentionScheduleResult,
  RunArtifactRetentionProcessResult,
} from '@pertexo/database';

export interface RetentionMetrics {
  recordSchedule(
    result: RetentionScheduleResult,
    durationSeconds: number,
  ): void;
  record(
    result: RetentionDryRunProcessResult | RetentionEnforcementProcessResult,
    durationSeconds: number,
    mode: 'dry_run' | 'enforce',
  ): void;
  recordFailure(durationSeconds: number): void;
  recordPreview(
    result: PreviewRetentionProcessResult,
    durationSeconds: number,
  ): void;
  recordRunArtifact(
    result: RunArtifactRetentionProcessResult,
    durationSeconds: number,
  ): void;
}

export function createRetentionMetrics(): RetentionMetrics {
  const meter = metrics.getMeter('@pertexo/retention', '0.0.0');
  const batches = meter.createCounter('pertexo.retention.batch.count');
  const rows = meter.createCounter('pertexo.retention.rows.count');
  const pages = meter.createCounter('pertexo.retention.page.count');
  const duration = meter.createHistogram('pertexo.retention.batch.duration', {
    unit: 's',
  });
  const scheduleScans = meter.createCounter(
    'pertexo.retention.schedule.scan.count',
  );
  const scheduleWorkspaces = meter.createCounter(
    'pertexo.retention.schedule.workspace.count',
  );
  const retentionMetrics: RetentionMetrics = {
    recordSchedule: (result, durationSeconds) => {
      const attributes = {
        mode: 'schedule',
        outcome: result.scheduledCount > 0 ? 'scheduled' : 'idle',
        retention_kind: 'all',
      };
      scheduleScans.add(1, attributes);
      scheduleWorkspaces.add(result.scannedCount, {
        ...attributes,
        workspace_outcome: 'scanned',
      });
      scheduleWorkspaces.add(result.scheduledCount, {
        ...attributes,
        workspace_outcome: 'scheduled',
      });
      duration.record(durationSeconds, attributes);
    },
    record: (
      result: RetentionDryRunProcessResult | RetentionEnforcementProcessResult,
      durationSeconds: number,
      mode: 'dry_run' | 'enforce',
    ) => {
      const attributes = {
        mode,
        outcome: result.status,
        retention_kind:
          result.status === 'idle' ? 'none' : result.retentionKind,
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
      if (result.status !== 'idle') {
        rows.add(result.examinedCount, {
          ...attributes,
          row_outcome: 'examined',
        });
        rows.add(result.eligibleCount, {
          ...attributes,
          row_outcome: 'eligible',
        });
        pages.add(result.pageCount, attributes);
      }
    },
    recordFailure: (durationSeconds: number) => {
      const attributes = {
        mode: 'dry_run',
        outcome: 'failed',
        retention_kind: 'workflow_run_input',
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
    },
    recordPreview: (
      result: PreviewRetentionProcessResult,
      durationSeconds: number,
    ) => {
      const attributes = {
        mode: 'enforce',
        outcome: result.status,
        retention_kind: 'preview',
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
      if (result.status !== 'idle') pages.add(1, attributes);
    },
    recordRunArtifact: (result, durationSeconds) => {
      const attributes = {
        mode: 'enforce',
        outcome: result.status,
        retention_kind: 'run_artifact',
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
      if (result.status !== 'idle') pages.add(1, attributes);
    },
  };
  return Object.freeze(retentionMetrics);
}
