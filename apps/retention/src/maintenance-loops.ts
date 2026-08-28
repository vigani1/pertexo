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

async function runOperatorRerunLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      const result = await resources.database.processOperatorRerun(signal);
      resources.metrics.recordOperatorRerun(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordRecovery(resources, 'operator_rerun', state);
      if (result !== null)
        resources.logger.info('retention.operator_rerun_processed', {
          outcome: result.outcome,
          targetType: result.targetType,
        });
      if (result === null)
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'operator_rerun',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runScheduleLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      const result = await resources.database.scheduleEnforcement(signal);
      resources.metrics.recordSchedule(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordRecovery(resources, 'schedule', state);
      if (result.scannedCount < 25)
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'schedule',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runDryRunLoop(
  resources: RetentionMaintenanceResources,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      const result = await resources.database.processNext(signal);
      resources.metrics.record(
        result,
        (performance.now() - startedAt) / 1_000,
        'dry_run',
      );
      recordRecovery(resources, 'dry_run', state);
      if (result.status !== 'idle')
        resources.logger.info('retention.batch_processed', {
          eligibleCount: result.eligibleCount,
          examinedCount: result.examinedCount,
          outcome: result.status,
          pageCount: result.pageCount,
        });
      if (result.status === 'idle')
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'dry_run',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runEnforcementLoop(
  resources: RetentionMaintenanceResources,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      await ledgerReady();
      const result = await resources.enforcement.processNext(signal);
      resources.metrics.record(
        result,
        (performance.now() - startedAt) / 1_000,
        'enforce',
      );
      recordRecovery(resources, 'enforce', state);
      if (result.status !== 'idle')
        resources.logger.info('retention.batch_processed', {
          eligibleCount: result.eligibleCount,
          examinedCount: result.examinedCount,
          outcome: result.status,
          pageCount: result.pageCount,
        });
      if (result.status !== 'completed')
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'enforce',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runPreviewLoop(
  resources: RetentionMaintenanceResources,
  artifactsReady: ReadinessGate,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      await Promise.all([artifactsReady(), ledgerReady()]);
      const result = await resources.preview.processNext(signal);
      resources.metrics.recordPreview(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordRecovery(resources, 'preview', state);
      if (result.status !== 'idle')
        resources.logger.info('retention.preview_processed', {
          outcome: result.status,
        });
      if (result.status !== 'completed' && result.status !== 'progressed')
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'preview',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runArtifactLoop(
  resources: RetentionMaintenanceResources,
  artifactsReady: ReadinessGate,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      await Promise.all([artifactsReady(), ledgerReady()]);
      const result = await resources.runArtifacts.processNext(signal);
      resources.metrics.recordRunArtifact(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordRecovery(resources, 'run_artifact', state);
      if (result.status !== 'idle')
        resources.logger.info('retention.run_artifact_processed', {
          outcome: result.status,
        });
      if (result.status !== 'completed')
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'run_artifact',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
}

async function runWorkspacePurgeLoop(
  resources: RetentionMaintenanceResources,
  artifactsReady: ReadinessGate,
  ledgerReady: ReadinessGate,
  signal: AbortSignal,
): Promise<void> {
  const state: OperationState = { consecutiveFailures: 0 };
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      await Promise.all([artifactsReady(), ledgerReady()]);
      const result = await resources.workspacePurge.processNext(signal);
      resources.metrics.recordWorkspacePurge(
        result,
        (performance.now() - startedAt) / 1_000,
      );
      recordRecovery(resources, 'workspace_purge', state);
      if (result.status !== 'idle')
        resources.logger.info('retention.workspace_purge_processed', {
          outcome: result.status,
        });
      if (result.status !== 'started' && result.status !== 'progressed')
        await waitForAbortableDelay(resources.pollIntervalMs, signal);
    } catch (error: unknown) {
      if (error === signal.reason) return;
      await recordFailure(
        resources,
        'workspace_purge',
        state,
        startedAt,
        error,
        signal,
      );
    }
  }
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
    runDryRunLoop(resources, signal),
    runEnforcementLoop(resources, ledgerReady, signal),
    runPreviewLoop(resources, artifactsReady, ledgerReady, signal),
    runArtifactLoop(resources, artifactsReady, ledgerReady, signal),
    runWorkspacePurgeLoop(resources, artifactsReady, ledgerReady, signal),
  ]);
}
