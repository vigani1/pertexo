import type { RetentionDatabase } from '@pertexo/database/testing';
import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { RetentionEnforcementCoordinator } from '@pertexo/database/testing';
import type { PreviewRetentionCoordinator } from '@pertexo/database/testing';
import type { RunArtifactRetentionCoordinator } from '@pertexo/database/testing';
import type { WorkspacePurgeCoordinator } from '@pertexo/database/testing';
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
    reapTransientData: vi.fn(() =>
      Promise.resolve({
        idempotencyRecordsDeleted: 0,
        sessionsDeleted: 0,
        workspaceCreationRecordsDeleted: 0,
      }),
    ),
    scheduleEnforcement: vi.fn(() =>
      Promise.resolve({
        capacityLimited: false,
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
    recordTransientDataReap: vi.fn(),
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

type TestResources = ReturnType<typeof resources>;
type MaintenanceOperation =
  | 'dry_run'
  | 'enforcement'
  | 'operator_rerun'
  | 'preview'
  | 'run_artifact'
  | 'scheduling'
  | 'transient_data_reap'
  | 'workspace_purge';

type MaintenanceLoopCase = Readonly<{
  name: string;
  operation: MaintenanceOperation;
  result: unknown;
  shouldPoll: boolean;
}>;

const batchIdentity = {
  batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  eligibleCount: 3,
  examinedCount: 3,
  pageCount: 1,
  retentionKind: 'workflow_run_input',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;
const lifecycleIdentity = {
  artifactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  previewRunId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;

const maintenanceLoopCases: readonly MaintenanceLoopCase[] = [
  {
    name: 'operator rerun polls when no command is ready',
    operation: 'operator_rerun',
    result: null,
    shouldPoll: true,
  },
  {
    name: 'operator rerun immediately continues after processing a command',
    operation: 'operator_rerun',
    result: {
      commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      outcome: 'completed',
      targetId: batchIdentity.batchId,
      targetType: 'retention_batch',
      workspaceId: batchIdentity.workspaceId,
    },
    shouldPoll: false,
  },
  {
    name: 'scheduling polls below capacity',
    operation: 'scheduling',
    result: {
      capacityLimited: false,
      cutoffAt: new Date('2026-08-26T00:00:00.000Z'),
      scannedCount: 3,
      scheduledCount: 3,
    },
    shouldPoll: true,
  },
  {
    name: 'scheduling immediately continues at capacity',
    operation: 'scheduling',
    result: {
      capacityLimited: true,
      cutoffAt: new Date('2026-08-26T00:00:00.000Z'),
      scannedCount: 25,
      scheduledCount: 25,
    },
    shouldPoll: false,
  },
  {
    name: 'transient-data reaping polls when no rows are deleted',
    operation: 'transient_data_reap',
    result: {
      idempotencyRecordsDeleted: 0,
      sessionsDeleted: 0,
      workspaceCreationRecordsDeleted: 0,
    },
    shouldPoll: true,
  },
  {
    name: 'transient-data reaping immediately continues after deletion',
    operation: 'transient_data_reap',
    result: {
      idempotencyRecordsDeleted: 1,
      sessionsDeleted: 2,
      workspaceCreationRecordsDeleted: 3,
    },
    shouldPoll: false,
  },
  ...(['idle'] as const).map((status) => ({
    name: `dry run polls after ${status}`,
    operation: 'dry_run' as const,
    result: { status },
    shouldPoll: true,
  })),
  ...(['completed', 'stale'] as const).map((status) => ({
    name: `dry run immediately continues after ${status}`,
    operation: 'dry_run' as const,
    result: { ...batchIdentity, status },
    shouldPoll: false,
  })),
  ...(['idle', 'paused', 'released', 'stale'] as const).map((status) => ({
    name: `enforcement polls after ${status}`,
    operation: 'enforcement' as const,
    result: status === 'idle' ? { status } : { ...batchIdentity, status },
    shouldPoll: true,
  })),
  {
    name: 'enforcement immediately continues after completed',
    operation: 'enforcement',
    result: { ...batchIdentity, status: 'completed' },
    shouldPoll: false,
  },
  ...(['idle', 'blocked', 'held', 'released', 'waiting'] as const).map(
    (status) => ({
      name: `preview retention polls after ${status}`,
      operation: 'preview' as const,
      result: status === 'idle' ? { status } : { ...lifecycleIdentity, status },
      shouldPoll: true,
    }),
  ),
  ...(['completed', 'progressed'] as const).map((status) => ({
    name: `preview retention immediately continues after ${status}`,
    operation: 'preview' as const,
    result: { ...lifecycleIdentity, status },
    shouldPoll: false,
  })),
  ...(
    ['idle', 'held', 'referenced', 'released', 'stale', 'waiting'] as const
  ).map((status) => ({
    name: `run-artifact retention polls after ${status}`,
    operation: 'run_artifact' as const,
    result: status === 'idle' ? { status } : { ...lifecycleIdentity, status },
    shouldPoll: true,
  })),
  {
    name: 'run-artifact retention immediately continues after completed',
    operation: 'run_artifact',
    result: { ...lifecycleIdentity, status: 'completed' },
    shouldPoll: false,
  },
  ...(['idle', 'completed', 'released', 'stale'] as const).map((status) => ({
    name: `workspace purge polls after ${status}`,
    operation: 'workspace_purge' as const,
    result: status === 'idle' ? { status } : { ...lifecycleIdentity, status },
    shouldPoll: true,
  })),
  ...(['started', 'progressed'] as const).map((status) => ({
    name: `workspace purge immediately continues after ${status}`,
    operation: 'workspace_purge' as const,
    result: { ...lifecycleIdentity, status },
    shouldPoll: false,
  })),
];

function rejectWhenWorkerStops(signal?: AbortSignal): Promise<never> {
  if (signal === undefined) return Promise.reject(new Error('signal missing'));
  const stopError = (): Error =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error('maintenance worker stopped');
  if (signal.aborted) return Promise.reject(stopError());
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(stopError());
      },
      { once: true },
    );
  });
}

function isolateMaintenanceOperations(input: TestResources): void {
  input.database.processOperatorRerun = vi.fn(rejectWhenWorkerStops);
  input.database.scheduleEnforcement = vi.fn(rejectWhenWorkerStops);
  input.database.reapTransientData = vi.fn(rejectWhenWorkerStops);
  input.database.processNext = vi.fn(rejectWhenWorkerStops);
  input.enforcement.processNext = vi.fn(rejectWhenWorkerStops);
  input.preview.processNext = vi.fn(rejectWhenWorkerStops);
  input.runArtifacts.processNext = vi.fn(rejectWhenWorkerStops);
  input.workspacePurge.processNext = vi.fn(rejectWhenWorkerStops);
}

function installMaintenanceResult(
  input: TestResources,
  operation: MaintenanceOperation,
  result: unknown,
): ReturnType<typeof vi.fn> {
  const execute = vi.fn(() => {
    if (execute.mock.calls.length === 2)
      input.controller.abort(new Error(`${operation} matrix complete`));
    return Promise.resolve(result);
  });
  switch (operation) {
    case 'operator_rerun':
      input.database.processOperatorRerun =
        execute as typeof input.database.processOperatorRerun;
      break;
    case 'scheduling':
      input.database.scheduleEnforcement =
        execute as typeof input.database.scheduleEnforcement;
      break;
    case 'transient_data_reap':
      input.database.reapTransientData =
        execute as typeof input.database.reapTransientData;
      break;
    case 'dry_run':
      input.database.processNext = execute as typeof input.database.processNext;
      break;
    case 'enforcement':
      input.enforcement.processNext =
        execute as typeof input.enforcement.processNext;
      break;
    case 'preview':
      input.preview.processNext = execute as typeof input.preview.processNext;
      break;
    case 'run_artifact':
      input.runArtifacts.processNext =
        execute as typeof input.runArtifacts.processNext;
      break;
    case 'workspace_purge':
      input.workspacePurge.processNext =
        execute as typeof input.workspacePurge.processNext;
  }
  return execute;
}

async function flushMaintenancePromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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
        capacityLimited: false,
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

  it.each(maintenanceLoopCases)(
    'preserves the public loop decision: $name',
    async ({ operation, result, shouldPoll }) => {
      vi.useFakeTimers();
      const input = resources([]);
      input.pollIntervalMs = 10_000;
      isolateMaintenanceOperations(input);
      const execute = installMaintenanceResult(input, operation, result);
      try {
        const running = runRetentionWorker(input);
        await flushMaintenancePromises();

        expect(execute).toHaveBeenCalledTimes(shouldPoll ? 1 : 2);
        if (shouldPoll) {
          await vi.advanceTimersByTimeAsync(input.pollIntervalMs);
          await flushMaintenancePromises();
          expect(execute).toHaveBeenCalledTimes(2);
        }
        await running;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('cancels a polling delay without another operation call', async () => {
    vi.useFakeTimers();
    const input = resources([]);
    input.pollIntervalMs = 10_000;
    isolateMaintenanceOperations(input);
    const execute = installMaintenanceResult(input, 'dry_run', {
      status: 'idle',
    });
    try {
      const running = runRetentionWorker(input);
      await flushMaintenancePromises();
      expect(execute).toHaveBeenCalledOnce();

      input.controller.abort(new Error('cancel polling delay'));
      await running;

      expect(execute).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a failure backoff without retrying the operation', async () => {
    vi.useFakeTimers();
    const input = resources([]);
    input.pollIntervalMs = 10_000;
    isolateMaintenanceOperations(input);
    const execute = vi.fn(() => Promise.reject(new Error('retry later')));
    input.database.processOperatorRerun = execute;
    try {
      const running = runRetentionWorker(input);
      await flushMaintenancePromises();
      expect(execute).toHaveBeenCalledOnce();
      expect(input.metrics.recordFailure).toHaveBeenCalledWith(
        'operator_rerun',
        expect.any(Number),
      );

      input.controller.abort(new Error('cancel failure backoff'));
      await running;

      expect(execute).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains another schedule batch immediately when capacity was reached', async () => {
    const input = resources([]);
    input.pollIntervalMs = 10_000;
    input.database.processNext = vi.fn(
      (signal?: AbortSignal) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              resolve({ status: 'idle' as const });
            },
            { once: true },
          );
        }),
    );
    let calls = 0;
    input.database.scheduleEnforcement = vi.fn(() => {
      calls += 1;
      if (calls === 2) input.controller.abort(new Error('schedule drained'));
      return Promise.resolve({
        capacityLimited: calls === 1,
        cutoffAt: new Date('2026-08-26T00:00:00.000Z'),
        scannedCount: calls === 1 ? 25 : 3,
        scheduledCount: calls === 1 ? 25 : 3,
      });
    });

    await expect(runRetentionWorker(input)).resolves.toBeUndefined();

    expect(input.database.scheduleEnforcement).toHaveBeenCalledTimes(2);
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

  it('preserves an undefined readiness rejection and still closes resources', async () => {
    const input = resources([]);
    input.database.checkReadiness = vi.fn(() => {
      // Deliberately exercise a hostile non-Error adapter rejection.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(undefined);
    });

    const error = await runRetentionWorker(input).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([undefined]);
    expect(input.processNext).not.toHaveBeenCalled();
    expect(input.events.slice(-2)).toEqual(['ledger-close', 'telemetry-close']);
  });
});
