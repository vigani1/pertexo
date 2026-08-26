import type { RetentionDatabase } from '@pertexo/database';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';

import type { RetentionMetrics } from './metrics.js';

export interface RetentionWorkerResources {
  readonly database: RetentionDatabase;
  readonly expectedMaintenanceRole: string;
  readonly logger: StructuredLogger;
  readonly metrics: RetentionMetrics;
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
    resources.logger.info('retention.ready');
    while (!resources.signal.aborted) {
      const startedAt = performance.now();
      try {
        const outcome = await resources.database.processNext(resources.signal);
        resources.metrics.record(
          outcome,
          (performance.now() - startedAt) / 1_000,
        );
        if (outcome.status !== 'idle') {
          resources.logger.info('retention.batch_processed', {
            eligibleCount: outcome.eligibleCount,
            examinedCount: outcome.examinedCount,
            outcome: outcome.status,
            pageCount: outcome.pageCount,
          });
        }
        if (outcome.status === 'idle' || outcome.status === 'stale') {
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
    () => resources.database.close(),
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
