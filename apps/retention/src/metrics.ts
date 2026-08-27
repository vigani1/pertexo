import { metrics, type Meter } from '@opentelemetry/api';
import type {
  OperatorMaintenanceRerunResult,
  RetentionDryRunProcessResult,
  RetentionEnforcementProcessResult,
  PreviewRetentionProcessResult,
  RetentionScheduleResult,
  RunArtifactRetentionProcessResult,
  WorkspacePurgeProcessResult,
} from '@pertexo/database';

export const RETENTION_METRIC_NAME = Object.freeze({
  batchCount: 'pertexo.retention.batch.count',
  batchDuration: 'pertexo.retention.batch.duration',
  failureCount: 'pertexo.retention.operation.failure.count',
  failureDuration: 'pertexo.retention.operation.failure.duration',
  operatorRerunCount: 'pertexo.maintenance.operator_rerun.count',
  operatorRerunDuration: 'pertexo.maintenance.operator_rerun.duration',
  pageCount: 'pertexo.retention.page.count',
  purgeCount: 'pertexo.purge.batch.count',
  purgeDuration: 'pertexo.purge.batch.duration',
  rowCount: 'pertexo.retention.rows.count',
  scheduleScanCount: 'pertexo.retention.schedule.scan.count',
  scheduleWorkspaceCount: 'pertexo.retention.schedule.workspace.count',
} as const);

export type RetentionOperation =
  | 'operator_rerun'
  | 'schedule'
  | 'dry_run'
  | 'enforce'
  | 'preview'
  | 'run_artifact'
  | 'workspace_purge';

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
  recordFailure(operation: RetentionOperation, durationSeconds: number): void;
  recordOperatorRerun(
    result: OperatorMaintenanceRerunResult | null,
    durationSeconds: number,
  ): void;
  recordPreview(
    result: PreviewRetentionProcessResult,
    durationSeconds: number,
  ): void;
  recordRunArtifact(
    result: RunArtifactRetentionProcessResult,
    durationSeconds: number,
  ): void;
  recordWorkspacePurge(
    result: WorkspacePurgeProcessResult,
    durationSeconds: number,
  ): void;
}

export function createRetentionMetrics(
  meter: Meter = metrics.getMeter('@pertexo/retention', '0.0.0'),
): RetentionMetrics {
  const batches = meter.createCounter(RETENTION_METRIC_NAME.batchCount, {
    description: 'Retention batches processed by bounded kind and outcome',
    unit: '{batch}',
  });
  const rows = meter.createCounter(RETENTION_METRIC_NAME.rowCount, {
    description: 'Retention rows examined or eligible for bounded deletion',
    unit: '{row}',
  });
  const pages = meter.createCounter(RETENTION_METRIC_NAME.pageCount, {
    description: 'Bounded retention pages processed',
    unit: '{page}',
  });
  const duration = meter.createHistogram(RETENTION_METRIC_NAME.batchDuration, {
    description:
      'Duration of one retention operation, excluding other poll work',
    unit: 's',
  });
  const scheduleScans = meter.createCounter(
    RETENTION_METRIC_NAME.scheduleScanCount,
    {
      description: 'Retention scheduling scans by bounded outcome',
      unit: '{scan}',
    },
  );
  const scheduleWorkspaces = meter.createCounter(
    RETENTION_METRIC_NAME.scheduleWorkspaceCount,
    {
      description: 'Workspaces scanned or scheduled for retention enforcement',
      unit: '{workspace}',
    },
  );
  const failures = meter.createCounter(RETENTION_METRIC_NAME.failureCount, {
    description: 'Retention worker failures attributed to the active operation',
    unit: '{failure}',
  });
  const failureDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.failureDuration,
    {
      description: 'Time spent in the retention operation that failed',
      unit: 's',
    },
  );
  const purgeCount = meter.createCounter(RETENTION_METRIC_NAME.purgeCount, {
    description: 'Workspace purge processing attempts by bounded outcome',
    unit: '{attempt}',
  });
  const purgeDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.purgeDuration,
    {
      description: 'Duration of one workspace purge processing attempt',
      unit: 's',
    },
  );
  const operatorRerunCount = meter.createCounter(
    RETENTION_METRIC_NAME.operatorRerunCount,
    {
      description:
        'Operator maintenance rerun processing by target and bounded outcome',
      unit: '{command}',
    },
  );
  const operatorRerunDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.operatorRerunDuration,
    {
      description: 'Duration of one operator maintenance rerun poll',
      unit: 's',
    },
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
    recordFailure: (operation, durationSeconds) => {
      failures.add(1, { operation });
      failureDuration.record(durationSeconds, { operation });
    },
    recordOperatorRerun: (result, durationSeconds) => {
      const knownOutcomes = new Set([
        'already_completed',
        'legal_hold',
        'lease_active',
        'not_found',
        'rerun_accepted',
      ]);
      const attributes = {
        outcome:
          result === null
            ? 'idle'
            : knownOutcomes.has(result.outcome)
              ? result.outcome
              : 'unknown',
        target_type: result?.targetType ?? 'none',
      };
      operatorRerunCount.add(1, attributes);
      operatorRerunDuration.record(durationSeconds, attributes);
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
    recordWorkspacePurge: (result, durationSeconds) => {
      const attributes = { outcome: result.status };
      purgeCount.add(1, attributes);
      purgeDuration.record(durationSeconds, attributes);
    },
  };
  return Object.freeze(retentionMetrics);
}
