import { metrics, type Meter } from '@opentelemetry/api';
import type {
  PreviewRetentionProcessResult,
  RetentionPassResult,
  RunArtifactRetentionProcessResult,
  WorkspacePurgeProcessResult,
} from '@pertexo/database/maintenance';

export const RETENTION_METRIC_NAME = Object.freeze({
  batchCount: 'pertexo.retention.batch.count',
  batchDuration: 'pertexo.retention.batch.duration',
  failureCount: 'pertexo.retention.operation.failure.count',
  failureDuration: 'pertexo.retention.operation.failure.duration',
  pageCount: 'pertexo.retention.page.count',
  purgeCount: 'pertexo.purge.batch.count',
  purgeDuration: 'pertexo.purge.batch.duration',
  rowCount: 'pertexo.retention.rows.count',
} as const);

export type RetentionOperation =
  'retention' | 'preview' | 'run_artifact' | 'workspace_purge';

export interface RetentionMetrics {
  /** One pass of the retention rules: rows each rule removed. */
  recordRetention(result: RetentionPassResult, durationSeconds: number): void;
  recordFailure(operation: RetentionOperation, durationSeconds: number): void;
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
    description: 'Retention pages processed by kind and outcome',
    unit: '{batch}',
  });
  const rows = meter.createCounter(RETENTION_METRIC_NAME.rowCount, {
    description: 'Rows retention removed or cleared, by rule',
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
  const retentionMetrics: RetentionMetrics = {
    recordRetention: (result, durationSeconds) => {
      let removed = 0;
      for (const [rule, count] of Object.entries(result.removed)) {
        const attributes = {
          mode: 'enforce',
          outcome: count > 0 ? 'deleted' : 'idle',
          retention_kind: rule,
        };
        batches.add(1, attributes);
        rows.add(count, { ...attributes, row_outcome: 'deleted' });
        removed += count;
      }
      duration.record(durationSeconds, {
        mode: 'enforce',
        outcome: removed > 0 ? 'deleted' : 'idle',
        retention_kind: 'all',
      });
    },
    recordFailure: (operation, durationSeconds) => {
      failures.add(1, { operation });
      failureDuration.record(durationSeconds, { operation });
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
