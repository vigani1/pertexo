import type { RetentionDatabase } from '@pertexo/database';
import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { RetentionEnforcementCoordinator } from '@pertexo/database';
import type { PreviewRetentionCoordinator } from '@pertexo/database';
import type { RunArtifactRetentionCoordinator } from '@pertexo/database';
import type { WorkspacePurgeCoordinator } from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import type { RetentionMetrics } from '../src/metrics.js';
import { runRetentionWorker } from '../src/run.js';

function resources(outcomes: ('completed' | 'idle' | 'stale')[]) {
  const controller = new AbortController();
  const events: string[] = [];
  const processNext = vi.fn(() => {
    const status = outcomes.shift() ?? 'idle';
    events.push(`process:${status}`);
    if (status !== 'completed') controller.abort(new Error('stop'));
    return Promise.resolve(
      status === 'idle'
        ? ({ status } as const)
        : ({
            batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eligibleCount: 3,
            examinedCount: 3,
            pageCount: 2,
            retentionKind: 'workflow_run_input',
            status,
            workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          } as const),
    );
  });
  const database = {
    checkReadiness: vi.fn(() => {
      events.push('database-ready');
      return Promise.resolve();
    }),
    claimDryRuns: vi.fn(),
    close: vi.fn(() => {
      events.push('database-close');
      return Promise.resolve();
    }),
    executeDryRunPage: vi.fn(),
    processNext,
    processOperatorRerun: vi.fn(() => Promise.resolve(null)),
    recordRegionalReplicaLag: vi.fn(() =>
      Promise.resolve({
        replayLagMillis: 0,
        replicationState: 'streaming',
        status: 'open' as const,
      }),
    ),
    scheduleEnforcement: vi.fn(() =>
      Promise.resolve({
        cutoffAt: new Date('2026-08-26T00:00:00.000Z'),
        scannedCount: 0,
        scheduledCount: 0,
      }),
    ),
    startDryRun: vi.fn(),
    startEnforcement: vi.fn(),
  } satisfies RetentionDatabase;
  const enforcement = {
    close: vi.fn(() => {
      events.push('enforcement-close');
      return Promise.resolve();
    }),
    processNext: vi.fn(() => Promise.resolve({ status: 'idle' as const })),
  } satisfies RetentionEnforcementCoordinator;
  const preview = {
    close: vi.fn(() => {
      events.push('preview-close');
      return Promise.resolve();
    }),
    processNext: vi.fn(() => Promise.resolve({ status: 'idle' as const })),
  } satisfies PreviewRetentionCoordinator;
  const runArtifacts = {
    close: vi.fn(() => {
      events.push('run-artifacts-close');
      return Promise.resolve();
    }),
    processNext: vi.fn(() => Promise.resolve({ status: 'idle' as const })),
  } satisfies RunArtifactRetentionCoordinator;
  const workspacePurge = {
    close: vi.fn(() => {
      events.push('workspace-purge-close');
      return Promise.resolve();
    }),
    processNext: vi.fn(() => Promise.resolve({ status: 'idle' as const })),
  } satisfies WorkspacePurgeCoordinator;
  const ledger = {
    append: vi.fn(),
    checkReadiness: vi.fn(() => {
      events.push('ledger-ready');
      return Promise.resolve({
        bucket: 'primary',
        minRetentionDays: 30,
        prefix: 'control-ledger/workspaces/' as const,
        primary: {
          bucket: 'primary',
          minRetentionDays: 30,
          prefix: 'control-ledger/workspaces/' as const,
          region: 'eu-central-1',
        },
        recovery: {
          bucket: 'recovery',
          minRetentionDays: 30,
          prefix: 'control-ledger/workspaces/' as const,
          region: 'eu-west-1',
        },
        region: 'eu-central-1',
      });
    }),
    close: vi.fn(() => events.push('ledger-close')),
    read: vi.fn(),
    reconcile: vi.fn(),
  } satisfies DualRegionControlLedger;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const metrics = {
    record: vi.fn(),
    recordFailure: vi.fn(),
    recordOperatorRerun: vi.fn(),
    recordPreview: vi.fn(),
    recordRegionalReplicaLag: vi.fn(),
    recordRunArtifact: vi.fn(),
    recordSchedule: vi.fn(),
    recordWorkspacePurge: vi.fn(),
  } satisfies RetentionMetrics;
  const telemetry = {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: vi.fn(() => {
      events.push('telemetry-close');
      return Promise.resolve();
    }),
    start: vi.fn(() => events.push('telemetry-start')),
  } satisfies TelemetryLifecycle;
  return {
    artifacts: {
      checkReadiness: vi.fn(() => {
        events.push('artifacts-ready');
        return Promise.resolve({});
      }),
      close: vi.fn(() => events.push('artifacts-close')),
    },
    controller,
    database,
    enforcement,
    events,
    expectedMaintenanceRole: 'pertexo_maintenance',
    logger,
    ledger,
    metrics,
    pollIntervalMs: 1,
    preview,
    replicaMonitor: {
      applicationName: 'pertexo-eu-west-1',
      sampleIntervalMs: 1_000,
    },
    processNext,
    runArtifacts,
    workspacePurge,
    signal: controller.signal,
    telemetry,
  };
}

describe('retention worker', () => {
  it('proves authority, drains completed work, records metrics, and closes', async () => {
    const input = resources(['completed', 'idle']);

    await expect(runRetentionWorker(input)).resolves.toBeUndefined();

    expect(input.events).toEqual([
      'telemetry-start',
      'database-ready',
      'process:completed',
      'ledger-ready',
      'artifacts-ready',
      'process:idle',
      'preview-close',
      'run-artifacts-close',
      'workspace-purge-close',
      'artifacts-close',
      'enforcement-close',
      'database-close',
      'ledger-close',
      'telemetry-close',
    ]);
    expect(input.metrics.record).toHaveBeenCalled();
    expect(input.metrics.recordOperatorRerun).toHaveBeenCalled();
    expect(input.metrics.recordSchedule).toHaveBeenCalled();
    expect(input.metrics.recordWorkspacePurge).toHaveBeenCalled();
  });

  it('measures every independently supervised poll operation', async () => {
    const input = resources(['idle']);
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const advance = <Result>(result: Result): Promise<Result> => {
      now += 100;
      return Promise.resolve(result);
    };
    input.database.processOperatorRerun = vi.fn(() => advance(null));
    input.database.scheduleEnforcement = vi.fn(() =>
      advance({
        cutoffAt: new Date('2026-08-26T00:00:00.000Z'),
        scannedCount: 0,
        scheduledCount: 0,
      }),
    );
    input.database.processNext = vi.fn(() =>
      advance({ status: 'idle' as const }),
    );
    input.enforcement.processNext = vi.fn(() =>
      advance({ status: 'idle' as const }),
    );
    input.preview.processNext = vi.fn(() =>
      advance({ status: 'idle' as const }),
    );
    input.runArtifacts.processNext = vi.fn(() =>
      advance({ status: 'idle' as const }),
    );
    input.workspacePurge.processNext = vi.fn(async () => {
      const result = await advance({ status: 'idle' as const });
      input.controller.abort(new Error('measurement complete'));
      return result;
    });

    try {
      await runRetentionWorker(input);
    } finally {
      clock.mockRestore();
    }

    expect(input.metrics.recordOperatorRerun).toHaveBeenCalledWith(
      null,
      expect.any(Number),
    );
    expect(input.metrics.recordSchedule).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Number),
    );
    expect(input.metrics.record).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.any(Number),
      'dry_run',
    );
    expect(input.metrics.record).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.any(Number),
      'enforce',
    );
    expect(input.metrics.recordPreview).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Number),
    );
    expect(input.metrics.recordRunArtifact).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Number),
    );
    expect(input.metrics.recordWorkspacePurge).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('backs off persistent failure without starving unrelated maintenance', async () => {
    const input = resources([]);
    input.database.processNext = vi.fn(async (signal?: AbortSignal) => {
      if (signal === undefined) throw new Error('signal missing');
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      return { status: 'idle' as const };
    });
    let attempts = 0;
    input.workspacePurge.processNext = vi.fn(() => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new Error('purge unavailable'));
      input.controller.abort(new Error('persistent failure recovered'));
      return Promise.resolve({ status: 'idle' as const });
    });

    await expect(runRetentionWorker(input)).resolves.toBeUndefined();

    expect(input.database.processNext).toHaveBeenCalledOnce();
    expect(input.database.scheduleEnforcement).toHaveBeenCalled();
    expect(input.workspacePurge.processNext).toHaveBeenCalledTimes(3);
    expect(input.metrics.recordFailure).toHaveBeenCalledTimes(2);
    expect(input.metrics.recordFailure).toHaveBeenNthCalledWith(
      2,
      'workspace_purge',
      expect.any(Number),
    );
    expect(input.logger.error).toHaveBeenLastCalledWith(
      'retention.operation_failed',
      {
        consecutiveFailures: 2,
        operation: 'workspace_purge',
        retryDelayMs: 2,
      },
      expect.any(Error),
    );
    expect(input.logger.info).toHaveBeenCalledWith(
      'retention.operation_recovered',
      { consecutiveFailures: 2, operation: 'workspace_purge' },
    );
  });

  it('isolates external readiness failure from database-only work', async () => {
    const input = resources([]);
    input.database.processNext = vi.fn(async () => {
      await Promise.resolve();
      input.controller.abort(new Error('database-only work observed'));
      return { status: 'idle' as const };
    });
    input.artifacts.checkReadiness = vi.fn(() =>
      Promise.reject(new Error('object store unavailable')),
    );

    await expect(runRetentionWorker(input)).resolves.toBeUndefined();

    expect(input.database.processNext).toHaveBeenCalledOnce();
    expect(input.database.scheduleEnforcement).toHaveBeenCalled();
    expect(input.preview.processNext).not.toHaveBeenCalled();
    expect(input.runArtifacts.processNext).not.toHaveBeenCalled();
    expect(input.workspacePurge.processNext).not.toHaveBeenCalled();
  });

  it('keeps unrelated maintenance running when replica observation fails', async () => {
    const input = resources(['idle']);
    input.database.recordRegionalReplicaLag = vi.fn(() =>
      Promise.reject(new Error('replica observation unavailable')),
    );

    await expect(runRetentionWorker(input)).resolves.toBeUndefined();

    expect(input.processNext).toHaveBeenCalledOnce();
    expect(input.logger.error).toHaveBeenCalledWith(
      'retention.regional_replica_lag_failed',
      { applicationName: 'pertexo-eu-west-1' },
      expect.any(Error),
    );
  });

  it('does not claim when readiness fails and still closes resources', async () => {
    const input = resources([]);
    input.database.checkReadiness = vi.fn(() =>
      Promise.reject(new Error('authority unavailable')),
    );

    await expect(runRetentionWorker(input)).rejects.toThrow(
      'Retention worker did not stop cleanly',
    );
    expect(input.processNext).not.toHaveBeenCalled();
    expect(input.events.slice(-2)).toEqual(['ledger-close', 'telemetry-close']);
  });
});
