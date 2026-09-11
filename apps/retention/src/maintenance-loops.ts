import type {
  PreviewRetentionCoordinator,
  RetentionDatabase,
  RetentionEnforcementCoordinator,
  RunArtifactRetentionCoordinator,
  WorkspacePurgeCoordinator,
} from '@pertexo/database/maintenance';
import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { StructuredLogger } from '@pertexo/observability/logging';
import { waitForAbortableDelay } from '@pertexo/observability/runtime';

import type { RetentionMetrics, RetentionOperation } from './metrics.js';

const MAXIMUM_FAILURE_BACKOFF_MS = 30_000;

export type RetentionMaintenanceResources = Readonly<{
  artifacts: { checkReadiness(): Promise<unknown> };
  database: RetentionDatabase;
  enforcement: RetentionEnforcementCoordinator;
  ledger: DualRegionControlLedger;
  logger: StructuredLogger;
  metrics: RetentionMetrics;
  pollIntervalMs: number;
  preview: PreviewRetentionCoordinator;
  runArtifacts: RunArtifactRetentionCoordinator;
  workspacePurge: WorkspacePurgeCoordinator;
}>;

interface OperationState {
  consecutiveFailures: number;
}

type ReadinessGate = () => Promise<void>;

function createReadinessGate(check: () => Promise<unknown>): ReadinessGate {
  let ready = false;
  let current: Promise<void> | undefined;
  return async (): Promise<void> => {
    if (ready) return;
    current ??= check()
      .then(() => {
        ready = true;
      })
      .finally(() => {
        current = undefined;
      });
    await current;
  };
}

function failureBackoffMs(
  pollIntervalMs: number,
  consecutiveFailures: number,
): number {
  return Math.min(
    MAXIMUM_FAILURE_BACKOFF_MS,
    pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 8),
  );
}

async function recordFailure(
  resources: RetentionMaintenanceResources,
  operation: RetentionOperation,
  state: OperationState,
  startedAt: number,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  state.consecutiveFailures += 1;
  const retryDelayMs = failureBackoffMs(
    resources.pollIntervalMs,
    state.consecutiveFailures,
  );
  resources.metrics.recordFailure(
    operation,
    (performance.now() - startedAt) / 1_000,
  );
  resources.logger.error(
    'retention.operation_failed',
    {
      consecutiveFailures: state.consecutiveFailures,
      operation,
      retryDelayMs,
    },
    error,
  );
  await waitForAbortableDelay(retryDelayMs, signal);
}

function recordRecovery(
  resources: RetentionMaintenanceResources,
  operation: RetentionOperation,
  state: OperationState,
): void {
  if (state.consecutiveFailures > 0)
    resources.logger.info('retention.operation_recovered', {
      consecutiveFailures: state.consecutiveFailures,
      operation,
    });
  state.consecutiveFailures = 0;
}

async function runOperationLoop(
  resources: RetentionMaintenanceResources,
  operation: RetentionOperation,
  signal: AbortSignal,
  executeIteration: (
    startedAt: number,
    recordOperationRecovery: () => void,
  ) => Promise<boolean>,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      const shouldPoll = await executeIteration(startedAt, () => {
        recordRecovery(resources, operation, state);
      });
      if (shouldPoll)
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        operation,
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runOperatorRerunLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'operator_rerun',
    signal,
    async (startedAt, recordOperationRecovery) => {
      const result = await resources.database.processOperatorRerun(signal);
      resources.metrics.recordOperatorRerun(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordOperationRecovery();
      if (result !== null)
        resources.logger.info('retention.operator_rerun_processed', {
          outcome: result.outcome,
          targetType: result.targetType,
        });
      return result === null;
    },
  );
}

async function runScheduleLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'schedule',
    signal,
    async (startedAt, recordOperationRecovery) => {
      const result = await resources.database.scheduleEnforcement(signal);
      resources.metrics.recordSchedule(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordOperationRecovery();
      return !result.capacityLimited;
    },
  );
}

async function runTransientDataReapLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'transient_data_reap',
    signal,
    async (startedAt, recordOperationRecovery) => {
      const result = await resources.database.reapTransientData(signal);
      resources.metrics.recordTransientDataReap(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordOperationRecovery();
      const deletedCount =
        result.idempotencyRecordsDeleted +
        result.workspaceCreationRecordsDeleted +
        result.sessionsDeleted;
      if (deletedCount > 0)
        resources.logger.info('retention.transient_data_reaped', {
          deletedCount,
          idempotencyRecordsDeleted: result.idempotencyRecordsDeleted,
          sessionsDeleted: result.sessionsDeleted,
          workspaceCreationRecordsDeleted:
            result.workspaceCreationRecordsDeleted,
        });
      return deletedCount === 0;
    },
  );
}

async function runDryRunLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'dry_run',
    signal,
    async (startedAt, recordOperationRecovery) => {
      const result = await resources.database.processNext(signal);
      resources.metrics.record(
        result,
        (performance.now() - startedAt) / 1_000,
        'dry_run',
      );
      recordOperationRecovery();
      if (result.status !== 'idle')
        resources.logger.info('retention.batch_processed', {
          eligibleCount: result.eligibleCount,
          examinedCount: result.examinedCount,
          outcome: result.status,
          pageCount: result.pageCount,
        });
      return result.status === 'idle';
    },
  );
}

async function runEnforcementLoop(
  resources: RetentionMaintenanceResources,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'enforce',
    signal,
    async (startedAt, recordOperationRecovery) => {
      await ledgerReady();
      const result = await resources.enforcement.processNext(signal);
      resources.metrics.record(
        result,
        (performance.now() - startedAt) / 1_000,
        'enforce',
      );
      recordOperationRecovery();
      if (result.status !== 'idle')
        resources.logger.info('retention.batch_processed', {
          eligibleCount: result.eligibleCount,
          examinedCount: result.examinedCount,
          outcome: result.status,
          pageCount: result.pageCount,
        });
      return result.status !== 'completed';
    },
  );
}

async function runPreviewLoop(
  resources: RetentionMaintenanceResources,
  artifactsReady: ReadinessGate,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'preview',
    signal,
    async (startedAt, recordOperationRecovery) => {
      await Promise.all([artifactsReady(), ledgerReady()]);
      const result = await resources.preview.processNext(signal);
      resources.metrics.recordPreview(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordOperationRecovery();
      if (result.status !== 'idle')
        resources.logger.info('retention.preview_processed', {
          outcome: result.status,
        });
      return result.status !== 'completed' && result.status !== 'progressed';
    },
  );
}

async function runArtifactLoop(
  resources: RetentionMaintenanceResources,
  artifactsReady: ReadinessGate,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'run_artifact',
    signal,
    async (startedAt, recordOperationRecovery) => {
      await Promise.all([artifactsReady(), ledgerReady()]);
      const result = await resources.runArtifacts.processNext(signal);
      resources.metrics.recordRunArtifact(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordOperationRecovery();
      if (result.status !== 'idle')
        resources.logger.info('retention.run_artifact_processed', {
          outcome: result.status,
        });
      return result.status !== 'completed';
    },
  );
}

async function runWorkspacePurgeLoop(
  resources: RetentionMaintenanceResources,
  artifactsReady: ReadinessGate,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  await runOperationLoop(
    resources,
    'workspace_purge',
    signal,
    async (startedAt, recordOperationRecovery) => {
      await Promise.all([artifactsReady(), ledgerReady()]);
      const result = await resources.workspacePurge.processNext(signal);
      resources.metrics.recordWorkspacePurge(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordOperationRecovery();
      if (result.status !== 'idle')
        resources.logger.info('retention.workspace_purge_processed', {
          outcome: result.status,
        });
      return result.status !== 'started' && result.status !== 'progressed';
    },
  );
}

export async function runMaintenanceLoops(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  const artifactsReady = createReadinessGate(() =>
    resources.artifacts.checkReadiness(),
  );
  const ledgerReady = createReadinessGate(() =>
    resources.ledger.checkReadiness(signal),
  );
  await Promise.all([
    runOperatorRerunLoop(resources, signal),
    runScheduleLoop(resources, signal),
    runTransientDataReapLoop(resources, signal),
    runDryRunLoop(resources, signal),
    runEnforcementLoop(resources, ledgerReady, signal),
    runPreviewLoop(resources, artifactsReady, ledgerReady, signal),
    runArtifactLoop(resources, artifactsReady, ledgerReady, signal),
    runWorkspacePurgeLoop(resources, artifactsReady, ledgerReady, signal),
  ]);
}
