import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  createRetentionMetrics,
  RETENTION_METRIC_NAME,
} from '../src/metrics.js';

describe('retention metrics', () => {
  it('attributes failures and emits cardinality-safe purge and rerun outcomes', () => {
    const instruments = new Map<
      string,
      { add: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> }
    >();
    const instrument = (name: string) => {
      const value = { add: vi.fn(), record: vi.fn() };
      instruments.set(name, value);
      return value;
    };
    const meter = {
      createCounter: vi.fn((name: string) => instrument(name)),
      createHistogram: vi.fn((name: string) => instrument(name)),
    } as unknown as Meter;
    const metrics = createRetentionMetrics(meter);

    metrics.recordFailure('workspace_purge', 0.25);
    metrics.recordWorkspacePurge(
      { status: 'progressed', jobId: 'ignored', workspaceId: 'ignored' },
      0.5,
    );
    metrics.recordOperatorRerun(
      {
        commandId: 'ignored',
        outcome: 'future_database_value',
        targetId: 'ignored',
        targetType: 'workspace_purge_job',
        workspaceId: 'ignored',
      },
      0.75,
    );

    expect(
      instruments.get(RETENTION_METRIC_NAME.failureCount)?.add,
    ).toHaveBeenCalledWith(1, {
      operation: 'workspace_purge',
    });
    expect(
      instruments.get(RETENTION_METRIC_NAME.failureDuration)?.record,
    ).toHaveBeenCalledWith(0.25, {
      operation: 'workspace_purge',
    });
    expect(
      instruments.get(RETENTION_METRIC_NAME.purgeCount)?.add,
    ).toHaveBeenCalledWith(1, {
      outcome: 'progressed',
    });
    expect(
      instruments.get(RETENTION_METRIC_NAME.operatorRerunCount)?.add,
    ).toHaveBeenCalledWith(1, {
      outcome: 'unknown',
      target_type: 'workspace_purge_job',
    });
  });
});
