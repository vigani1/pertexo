import type { DualRegionControlLedger } from '@pertexo/artifact-store';
import type {
  RetentionDatabase,
  RetentionEnforcementCoordinator,
  PreviewRetentionCoordinator,
} from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

import type { RetentionMetrics } from './metrics.js';

export interface RetentionWorkerResources {
  readonly artifacts: { checkReadiness(): Promise<unknown>; close(): void };
  readonly database: RetentionDatabase;
  readonly enforcement: RetentionEnforcementCoordinator;
  readonly expectedMaintenanceRole: string;
  readonly logger: StructuredLogger;
  readonly ledger: DualRegionControlLedger;
  readonly metrics: RetentionMetrics;
  readonly preview: PreviewRetentionCoordinator;
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
      const startedAt = performance.now();
      try {
        const schedule = await resources.database.scheduleEnforcement(
          resources.signal,
        );
        resources.metrics.recordSchedule(
          schedule,
          (performance.now() - startedAt) / 1_000,
        );
        const dryRun = await resources.database.processNext(resources.signal);
        resources.metrics.record(
          dryRun,
          (performance.now() - startedAt) / 1_000,
          'dry_run',
        );
        const enforcement = await resources.enforcement.processNext(
          resources.signal,
        );
        resources.metrics.record(
          enforcement,
          (performance.now() - startedAt) / 1_000,
          'enforce',
        );
        const preview = await resources.preview.processNext(resources.signal);
        resources.metrics.recordPreview(
          preview,
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
        if (
          schedule.scannedCount < 25 &&
          dryRun.status === 'idle' &&
          enforcement.status !== 'completed' &&
          preview.status !== 'completed' &&
          preview.status !== 'progressed'
        ) {
          await waitForNextPoll(resources.pollIntervalMs, resources.signal);
        }
      } catch (error: unknown) {
        resources.metrics.recordFailure(
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
