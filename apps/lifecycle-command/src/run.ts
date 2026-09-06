import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { WorkspaceLifecycleCommandCoordinator } from '@pertexo/database/lifecycle';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { MaintenanceMetrics } from '@pertexo/observability';
import { waitForAbortableDelay } from '@pertexo/observability/runtime';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

export interface LifecycleCommandResources {
  readonly coordinator: WorkspaceLifecycleCommandCoordinator;
  readonly expectedLifecycleCommandRole: string;
  readonly ledger: DualRegionControlLedger;
  readonly logger: StructuredLogger;
  readonly metrics: MaintenanceMetrics;
  readonly pollIntervalMs: number;
  readonly readiness: Readonly<{
    clear(): Promise<void>;
    mark(): Promise<void>;
  }>;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

export async function runLifecycleCommandWorker(
  resources: LifecycleCommandResources,
): Promise<void> {
  let operationError: unknown;
  let operationFailed = false;
  try {
    resources.telemetry.start();
    await resources.readiness.clear();
    resources.signal.throwIfAborted();
    await resources.coordinator.checkReadiness({
      expectedLifecycleCommandRole: resources.expectedLifecycleCommandRole,
      signal: resources.signal,
    });
    const readiness = await resources.ledger.checkReadiness(resources.signal);
    await resources.readiness.mark();
    resources.logger.info('lifecycle_command.ready', {
      primaryRegion: readiness.primary.region,
      recoveryRegion: readiness.recovery.region,
    });

    while (!resources.signal.aborted) {
      const startedAt = performance.now();
      let outcome;
      try {
        outcome = await resources.coordinator.processNext({
          signal: resources.signal,
        });
      } catch (error: unknown) {
        resources.metrics.recordLifecycleCommand(
          'unknown',
          'failed',
          (performance.now() - startedAt) / 1_000,
        );
        throw error;
      }
      if (outcome.status !== 'idle') {
        resources.metrics.recordLifecycleCommand(
          outcome.commandType,
          outcome.status,
          (performance.now() - startedAt) / 1_000,
        );
        resources.logger.info('lifecycle_command.processed', {
          commandType: outcome.commandType,
          operationId: outcome.operationId,
          outcome: outcome.status,
        });
      }
      if (
        outcome.status === 'idle' ||
        outcome.status === 'released' ||
        outcome.status === 'stale'
      ) {
        await waitForAbortableDelay(resources.pollIntervalMs, resources.signal);
      }
    }
  } catch (error: unknown) {
    const expectedAbort =
      resources.signal.aborted && error === resources.signal.reason;
    if (!expectedAbort) {
      operationError = error;
      operationFailed = true;
    }
  }

  const cleanupErrors: unknown[] = [];
  for (const close of [
    () => resources.readiness.clear(),
    () => resources.coordinator.close(),
    () => {
      resources.ledger.close();
    },
    () => resources.telemetry.shutdown(),
  ]) {
    await Promise.resolve()
      .then(close)
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  const errors = [
    ...(operationFailed ? [operationError] : []),
    ...cleanupErrors,
  ];
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Lifecycle command worker did not stop cleanly',
    );
}
