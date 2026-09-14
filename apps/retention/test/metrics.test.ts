import type { Meter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import {
  createRetentionMetrics,
  RETENTION_METRIC_NAME,
} from '../src/metrics.js';

type Instrument = Readonly<{
  add: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}>;

function setupMetrics() {
  const instruments = new Map<string, Instrument>();
  const instrument = (name: string) => {
    const value = { add: vi.fn(), record: vi.fn() };
    instruments.set(name, value);
    return value;
  };
  const createInstrument = (
    name: string,
    options?: Readonly<{ unit?: string }>,
  ) => {
    void options;
    return instrument(name);
  };
  const createCounter = vi.fn(createInstrument);
  const createGauge = vi.fn(createInstrument);
  const createHistogram = vi.fn(createInstrument);
  const meter = {
    createCounter,
    createGauge,
    createHistogram,
  } as unknown as Meter;
  return {
    instrumentFactories: [createCounter, createGauge, createHistogram],
    instruments,
    meter,
    metrics: createRetentionMetrics(meter, () => 1_750_000_000_000),
  };
}

function callsFor(
  instruments: ReadonlyMap<string, Instrument>,
  name: string,
  method: keyof Instrument,
) {
  return instruments.get(name)?.[method].mock.calls;
}

describe('retention metrics', () => {
  it('creates every instrument with its exact unit', () => {
    const { instrumentFactories } = setupMetrics();
    const definitions = instrumentFactories
      .flatMap((factory) => factory.mock.calls)
      .map(([name, options]) => [name, options?.unit])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));

    expect(definitions).toEqual(
      [
        [RETENTION_METRIC_NAME.batchCount, '{batch}'],
        [RETENTION_METRIC_NAME.batchDuration, 's'],
        [RETENTION_METRIC_NAME.failureCount, '{failure}'],
        [RETENTION_METRIC_NAME.failureDuration, 's'],
        [RETENTION_METRIC_NAME.operatorRerunCount, '{command}'],
        [RETENTION_METRIC_NAME.operatorRerunDuration, 's'],
        [RETENTION_METRIC_NAME.pageCount, '{page}'],
        [RETENTION_METRIC_NAME.purgeCount, '{attempt}'],
        [RETENTION_METRIC_NAME.purgeDuration, 's'],
        [RETENTION_METRIC_NAME.regionalReplicaAdmissionBlocked, '1'],
        [RETENTION_METRIC_NAME.regionalReplicaObservationTime, 's'],
        [RETENTION_METRIC_NAME.regionalReplicaReplayLag, 's'],
        [RETENTION_METRIC_NAME.rowCount, '{row}'],
        [RETENTION_METRIC_NAME.scheduleScanCount, '{scan}'],
        [RETENTION_METRIC_NAME.scheduleWorkspaceCount, '{workspace}'],
        [RETENTION_METRIC_NAME.transientDataReapCount, '{row}'],
      ].sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
  });

  it('records failure count and duration for the bounded operation', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordFailure('workspace_purge', 0.25);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.failureCount, 'add'),
    ).toEqual([[1, { operation: 'workspace_purge' }]]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.failureDuration, 'record'),
    ).toEqual([[0.25, { operation: 'workspace_purge' }]]);
  });

  it('records open, paused, and unavailable replica admission with nullable lag', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordRegionalReplicaLag({
      replayLagMillis: 300_000,
      replicationState: 'streaming',
      status: 'open',
    });
    metrics.recordRegionalReplicaLag({
      replayLagMillis: null,
      replicationState: 'catchup',
      status: 'paused',
    });
    metrics.recordRegionalReplicaLag({
      replayLagMillis: null,
      replicationState: 'unknown',
      status: 'unavailable',
    });
    expect(
      callsFor(
        instruments,
        RETENTION_METRIC_NAME.regionalReplicaAdmissionBlocked,
        'record',
      ),
    ).toEqual([[0], [1], [1]]);
    expect(
      callsFor(
        instruments,
        RETENTION_METRIC_NAME.regionalReplicaObservationTime,
        'record',
      ),
    ).toEqual([[1_750_000_000], [1_750_000_000], [1_750_000_000]]);
    expect(
      callsFor(
        instruments,
        RETENTION_METRIC_NAME.regionalReplicaReplayLag,
        'record',
      ),
    ).toEqual([[300]]);
  });

  it('records purge outcome and duration without tenant identifiers', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordWorkspacePurge(
      { status: 'progressed', jobId: 'ignored', workspaceId: 'ignored' },
      0.5,
    );
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.purgeCount, 'add'),
    ).toEqual([[1, { outcome: 'progressed' }]]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.purgeDuration, 'record'),
    ).toEqual([[0.5, { outcome: 'progressed' }]]);
  });

  it('bounds known, unknown, and idle operator rerun outcomes', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordOperatorRerun(
      {
        commandId: 'ignored-command',
        outcome: 'rerun_accepted',
        targetId: 'ignored-target',
        targetType: 'retention_batch',
        workspaceId: 'ignored-workspace',
      },
      0.1,
    );
    metrics.recordOperatorRerun(
      {
        commandId: 'ignored-command',
        outcome: 'future_database_value',
        targetId: 'ignored-target',
        targetType: 'workspace_purge_job',
        workspaceId: 'ignored-workspace',
      },
      0.2,
    );
    metrics.recordOperatorRerun(null, 0.3);
    const attributes = [
      { outcome: 'rerun_accepted', target_type: 'retention_batch' },
      { outcome: 'unknown', target_type: 'workspace_purge_job' },
      { outcome: 'idle', target_type: 'none' },
    ];
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.operatorRerunCount, 'add'),
    ).toEqual(attributes.map((value) => [1, value]));
    expect(
      callsFor(
        instruments,
        RETENTION_METRIC_NAME.operatorRerunDuration,
        'record',
      ),
    ).toEqual(attributes.map((value, index) => [(index + 1) / 10, value]));
  });

  it('records idle and scheduled scans and workspace counts', () => {
    const { instruments, metrics } = setupMetrics();
    const cutoffAt = new Date('2026-08-26T00:00:00.000Z');
    metrics.recordSchedule(
      { capacityLimited: false, cutoffAt, scannedCount: 4, scheduledCount: 0 },
      0.4,
    );
    metrics.recordSchedule(
      { capacityLimited: true, cutoffAt, scannedCount: 9, scheduledCount: 3 },
      0.6,
    );
    const idle = { mode: 'schedule', outcome: 'idle', retention_kind: 'all' };
    const scheduled = {
      mode: 'schedule',
      outcome: 'scheduled',
      retention_kind: 'all',
    };
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.scheduleScanCount, 'add'),
    ).toEqual([
      [1, idle],
      [1, scheduled],
    ]);
    expect(
      callsFor(
        instruments,
        RETENTION_METRIC_NAME.scheduleWorkspaceCount,
        'add',
      ),
    ).toEqual([
      [4, { ...idle, workspace_outcome: 'scanned' }],
      [0, { ...idle, workspace_outcome: 'scheduled' }],
      [9, { ...scheduled, workspace_outcome: 'scanned' }],
      [3, { ...scheduled, workspace_outcome: 'scheduled' }],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchDuration, 'record'),
    ).toEqual([
      [0.4, idle],
      [0.6, scheduled],
    ]);
  });

  it('records each transient data class and idle versus deleted duration', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordTransientDataReap(
      {
        idempotencyRecordsDeleted: 0,
        sessionsDeleted: 0,
        workspaceCreationRecordsDeleted: 0,
      },
      0.7,
    );
    metrics.recordTransientDataReap(
      {
        idempotencyRecordsDeleted: 2,
        sessionsDeleted: 3,
        workspaceCreationRecordsDeleted: 5,
      },
      0.8,
    );
    expect(
      callsFor(
        instruments,
        RETENTION_METRIC_NAME.transientDataReapCount,
        'add',
      ),
    ).toEqual([
      [0, { data_class: 'idempotency_record' }],
      [0, { data_class: 'workspace_creation_idempotency_record' }],
      [0, { data_class: 'session' }],
      [2, { data_class: 'idempotency_record' }],
      [5, { data_class: 'workspace_creation_idempotency_record' }],
      [3, { data_class: 'session' }],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchDuration, 'record'),
    ).toEqual([
      [
        0.7,
        {
          mode: 'transient_data_reap',
          outcome: 'idle',
          retention_kind: 'transient_data',
        },
      ],
      [
        0.8,
        {
          mode: 'transient_data_reap',
          outcome: 'deleted',
          retention_kind: 'transient_data',
        },
      ],
    ]);
  });

  it('records idle and non-idle retention batches with exact rows and pages', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.record({ status: 'idle' }, 0.9, 'dry_run');
    metrics.record(
      {
        batchId: 'ignored-batch',
        eligibleCount: 3,
        examinedCount: 7,
        pageCount: 2,
        retentionKind: 'workflow_run_input',
        status: 'completed',
        workspaceId: 'ignored-workspace',
      },
      1.1,
      'enforce',
    );
    const idle = { mode: 'dry_run', outcome: 'idle', retention_kind: 'none' };
    const completed = {
      mode: 'enforce',
      outcome: 'completed',
      retention_kind: 'workflow_run_input',
    };
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchCount, 'add'),
    ).toEqual([
      [1, idle],
      [1, completed],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.rowCount, 'add'),
    ).toEqual([
      [7, { ...completed, row_outcome: 'examined' }],
      [3, { ...completed, row_outcome: 'eligible' }],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.pageCount, 'add'),
    ).toEqual([[2, completed]]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchDuration, 'record'),
    ).toEqual([
      [0.9, idle],
      [1.1, completed],
    ]);
  });

  it('records preview and run-artifact idle and non-idle branches', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordPreview({ status: 'idle' }, 1.2);
    metrics.recordPreview(
      {
        artifactId: 'ignored-artifact',
        previewRunId: 'ignored-preview',
        status: 'completed',
        workspaceId: 'ignored-workspace',
      },
      1.3,
    );
    metrics.recordRunArtifact({ status: 'idle' }, 1.4);
    metrics.recordRunArtifact(
      {
        artifactId: 'ignored-artifact',
        status: 'referenced',
        workspaceId: 'ignored-workspace',
      },
      1.5,
    );
    const previewIdle = {
      mode: 'enforce',
      outcome: 'idle',
      retention_kind: 'preview',
    };
    const previewComplete = {
      mode: 'enforce',
      outcome: 'completed',
      retention_kind: 'preview',
    };
    const artifactIdle = {
      mode: 'enforce',
      outcome: 'idle',
      retention_kind: 'run_artifact',
    };
    const artifactReferenced = {
      mode: 'enforce',
      outcome: 'referenced',
      retention_kind: 'run_artifact',
    };
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchCount, 'add'),
    ).toEqual([
      [1, previewIdle],
      [1, previewComplete],
      [1, artifactIdle],
      [1, artifactReferenced],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.pageCount, 'add'),
    ).toEqual([
      [1, previewComplete],
      [1, artifactReferenced],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchDuration, 'record'),
    ).toEqual([
      [1.2, previewIdle],
      [1.3, previewComplete],
      [1.4, artifactIdle],
      [1.5, artifactReferenced],
    ]);
  });
});
