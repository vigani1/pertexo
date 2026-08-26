import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type { WorkspaceLifecycleCommandCoordinator } from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

export interface LifecycleCommandResources {
  readonly coordinator: WorkspaceLifecycleCommandCoordinator;
  readonly ledger: DualRegionControlLedger;
  readonly logger: StructuredLogger;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly telemetry: TelemetryLifecycle;
}

function waitForNextPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function runLifecycleCommandWorker(
  resources: LifecycleCommandResources,
): Promise<void> {
  let operationError: unknown;
  try {
    resources.telemetry.start();
    resources.signal.throwIfAborted();
    const readiness = await resources.ledger.checkReadiness(resources.signal);
    resources.logger.info('lifecycle_command.ready', {
      primaryRegion: readiness.primary.region,
      recoveryRegion: readiness.recovery.region,
    });

    while (!resources.signal.aborted) {
      const outcome = await resources.coordinator.processNext({
        signal: resources.signal,
      });
      if (outcome.status !== 'idle') {
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
        await waitForNextPoll(resources.pollIntervalMs, resources.signal);
      }
    }
  } catch (error: unknown) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const close of [
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
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors].filter((error) => error !== undefined),
      'Lifecycle command worker did not stop cleanly',
    );
  }
}
