import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type {
  RetentionDatabase,
  RetentionEnforcementCoordinator,
  PreviewRetentionCoordinator,
  RunArtifactRetentionCoordinator,
  WorkspacePurgeCoordinator,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { waitForAbortableDelay } from '@pertexo/observability/runtime';

import type { RetentionMetrics, RetentionOperation } from './metrics.js';

export interface RetentionWorkerResources {
  readonly artifacts: { checkReadiness(): Promise<unknown>; close(): void };
  readonly database: RetentionDatabase;
  readonly enforcement: RetentionEnforcementCoordinator;
  readonly expectedMaintenanceRole: string;
  readonly logger: StructuredLogger;
  readonly ledger: DualRegionControlLedger;
  readonly metrics: RetentionMetrics;
  readonly preview: PreviewRetentionCoordinator;
  readonly runArtifacts: RunArtifactRetentionCoordinator;
  readonly workspacePurge: WorkspacePurgeCoordinator;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

export async function runRetentionWorker(
  resources: RetentionWorkerResources,
): Promise<void> {
  let operationError: unknown;
  try {
    resources.telemetry.start();
    await resources.database.checkReadiness({
      expectedMaintenanceRole: resources.expectedMaintenanceRole,
      signal: resources.signal,
    });
    await resources.ledger.checkReadiness(resources.signal);
    await resources.artifacts.checkReadiness();
    resources.logger.info('retention.ready');
    while (!resources.signal.aborted) {
      let operation: RetentionOperation = 'operator_rerun';
      let startedAt = performance.now();
      try {
        const operatorRerun = await resources.database.processOperatorRerun(
          resources.signal,
        );
        resources.metrics.recordOperatorRerun(
          operatorRerun,
          (performance.now() - startedAt) / 1_000,
        );
        operation = 'schedule';
        startedAt = performance.now();
        const schedule = await resources.database.scheduleEnforcement(
          resources.signal,
        );
        resources.metrics.recordSchedule(
          schedule,
          (performance.now() - startedAt) / 1_000,
        );
        operation = 'dry_run';
        startedAt = performance.now();
        const dryRun = await resources.database.processNext(resources.signal);
        resources.metrics.record(
          dryRun,
          (performance.now() - startedAt) / 1_000,
          'dry_run',
        );
        operation = 'enforce';
        startedAt = performance.now();
        const enforcement = await resources.enforcement.processNext(
          resources.signal,
        );
        resources.metrics.record(
          enforcement,
          (performance.now() - startedAt) / 1_000,
          'enforce',
        );
        operation = 'preview';
        startedAt = performance.now();
        const preview = await resources.preview.processNext(resources.signal);
        resources.metrics.recordPreview(
          preview,
          (performance.now() - startedAt) / 1_000,
        );
        operation = 'run_artifact';
        startedAt = performance.now();
        const runArtifact = await resources.runArtifacts.processNext(
          resources.signal,
        );
        resources.metrics.recordRunArtifact(
          runArtifact,
          (performance.now() - startedAt) / 1_000,
        );
        operation = 'workspace_purge';
        startedAt = performance.now();
        const workspacePurge = await resources.workspacePurge.processNext(
          resources.signal,
        );
        resources.metrics.recordWorkspacePurge(
          workspacePurge,
          (performance.now() - startedAt) / 1_000,
        );
        for (const outcome of [dryRun, enforcement]) {
          if (outcome.status === 'idle') continue;
          resources.logger.info('retention.batch_processed', {
            eligibleCount: outcome.eligibleCount,
            examinedCount: outcome.examinedCount,
            outcome: outcome.status,
            pageCount: outcome.pageCount,
          });
        }
        if (preview.status !== 'idle') {
          resources.logger.info('retention.preview_processed', {
            outcome: preview.status,
          });
        }
        if (runArtifact.status !== 'idle') {
          resources.logger.info('retention.run_artifact_processed', {
            outcome: runArtifact.status,
          });
        }
        if (workspacePurge.status !== 'idle') {
          resources.logger.info('retention.workspace_purge_processed', {
            outcome: workspacePurge.status,
          });
        }
        if (operatorRerun !== null) {
          resources.logger.info('retention.operator_rerun_processed', {
            outcome: operatorRerun.outcome,
            targetType: operatorRerun.targetType,
          });
        }
        if (
          schedule.scannedCount < 25 &&
          dryRun.status === 'idle' &&
          enforcement.status !== 'completed' &&
          preview.status !== 'completed' &&
          preview.status !== 'progressed' &&
          runArtifact.status !== 'completed' &&
          workspacePurge.status !== 'started' &&
          workspacePurge.status !== 'progressed'
        ) {
          await waitForAbortableDelay(
            resources.pollIntervalMs,
            resources.signal,
          );
        }
      } catch (error: unknown) {
        resources.metrics.recordFailure(
          operation,
          (performance.now() - startedAt) / 1_000,
        );
        throw error;
      }
    }
  } catch (error: unknown) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const close of [
    () => resources.preview.close(),
    () => resources.runArtifacts.close(),
    () => resources.workspacePurge.close(),
    () => {
      resources.artifacts.close();
    },
    () => resources.enforcement.close(),
    () => resources.database.close(),
    () => {
      resources.ledger.close();
    },
    () => resources.telemetry.shutdown(),
  ]) {
    await Promise.resolve()
      .then(close)
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors].filter((error) => error !== undefined),
      'Retention worker did not stop cleanly',
    );
  }
}
