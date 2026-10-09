import type { Meter } from '@opentelemetry/api';
import type { RetentionPassResult } from '@pertexo/database/lifecycle';
import { describe, expect, it, vi } from 'vitest';

import {
  createRetentionMetrics,
  RETENTION_METRIC_NAME,
} from '../../src/retention/metrics.js';

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
    _options?: Readonly<{ unit?: string }>,
  ) => {
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
    metrics: createRetentionMetrics(meter),
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
        [RETENTION_METRIC_NAME.pageCount, '{page}'],
        [RETENTION_METRIC_NAME.purgeCount, '{attempt}'],
        [RETENTION_METRIC_NAME.purgeDuration, 's'],
        [RETENTION_METRIC_NAME.rowCount, '{row}'],
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

  it('records purge outcome and duration without tenant identifiers', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordWorkspacePurge(
      { status: 'progressed', workspaceId: 'ignored', step: 'workflow_runs' },
      0.5,
    );
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.purgeCount, 'add'),
    ).toEqual([[1, { outcome: 'progressed' }]]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.purgeDuration, 'record'),
    ).toEqual([[0.5, { outcome: 'progressed' }]]);
  });

  it('records each rule of a retention pass and the pass duration', () => {
    const { instruments, metrics } = setupMetrics();
    metrics.recordRetention(
      {
        removed: {
          run_inputs: 3,
          audit_events: 0,
        } as RetentionPassResult['removed'],
        more: false,
      },
      1.1,
    );
    const deleted = {
      mode: 'enforce',
      outcome: 'deleted',
      retention_kind: 'run_inputs',
    };
    const idle = {
      mode: 'enforce',
      outcome: 'idle',
      retention_kind: 'audit_events',
    };
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchCount, 'add'),
    ).toEqual([
      [1, deleted],
      [1, idle],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.rowCount, 'add'),
    ).toEqual([
      [3, { ...deleted, row_outcome: 'deleted' }],
      [0, { ...idle, row_outcome: 'deleted' }],
    ]);
    expect(
      callsFor(instruments, RETENTION_METRIC_NAME.batchDuration, 'record'),
    ).toEqual([
      [1.1, { mode: 'enforce', outcome: 'deleted', retention_kind: 'all' }],
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
