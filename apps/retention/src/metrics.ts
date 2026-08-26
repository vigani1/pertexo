import { metrics } from '@opentelemetry/api';
import type {
  RetentionDryRunProcessResult,
  RetentionEnforcementProcessResult,
} from '@pertexo/database';

export interface RetentionMetrics {
  record(
    result: RetentionDryRunProcessResult | RetentionEnforcementProcessResult,
    durationSeconds: number,
    mode: 'dry_run' | 'enforce',
  ): void;
  recordFailure(durationSeconds: number): void;
}

export function createRetentionMetrics(): RetentionMetrics {
  const meter = metrics.getMeter('@pertexo/retention', '0.0.0');
  const batches = meter.createCounter('pertexo.retention.batch.count');
  const rows = meter.createCounter('pertexo.retention.rows.count');
  const pages = meter.createCounter('pertexo.retention.page.count');
  const duration = meter.createHistogram('pertexo.retention.batch.duration', {
    unit: 's',
  });
  const retentionMetrics: RetentionMetrics = {
    record: (
      result: RetentionDryRunProcessResult | RetentionEnforcementProcessResult,
      durationSeconds: number,
      mode: 'dry_run' | 'enforce',
    ) => {
      const attributes = {
        mode,
        outcome: result.status,
        retention_kind: 'workflow_run_input',
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
  };
  return Object.freeze(retentionMetrics);
}
