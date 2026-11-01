import { writeFile } from 'node:fs/promises';

import {
  createStalledWorkStore,
  type StalledWorkRecovery,
  type StalledWorkStore,
} from '@pertexo/core/runs';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerConfig } from '../config/worker.js';
import {
  createPollingRuntime,
  reportDiagnostic,
  type PollingRuntime,
} from '../runtime/polling.js';

export type StalledWorkRuntime = PollingRuntime;

export const STALLED_WORK_RUNTIME = Symbol('STALLED_WORK_RUNTIME');

/** Short beside the 30 s lease, and cheap: indexed reads when nothing is due. */
const SCAN_INTERVAL_MILLIS = 5_000;
const SCAN_BATCH_SIZE = 50;

/**
 * The container's health check reads this file's age, and its contents to end a
 * worker that has stopped. A settled cycle counts even when it failed: a database
 * outage is no reason to restart anything, and only a stopped loop leaves it stale.
 */
const PROGRESS_MARKER = '/tmp/pertexo-worker-progress';

/**
 * ADR 007: acts on everything whose recorded time has passed, which is what makes
 * a crash, restart or lost job recoverable. Every worker runs it; a row's lock and
 * the consumers' receipts and fences make a second worker's attempt a no-op.
 */
function createStalledWorkRuntime(
  store: StalledWorkStore,
  logger: StructuredLogger,
): StalledWorkRuntime {
  return createPollingRuntime({
    name: 'Stalled work',
    pollMillis: SCAN_INTERVAL_MILLIS,
    cycle: async (signal) => {
      try {
        const { recovered, failed } = await store.recoverDue(
          SCAN_BATCH_SIZE,
          signal,
        );
        reportDiagnostic(() => {
          for (const recovery of recovered)
            if (recovery.kind === 'delivery_given_up')
              logger.warn(recoveryEvent(recovery), recovery);
            else logger.info(recoveryEvent(recovery), recovery);
          for (const { error, ...failure } of failed)
            logger.warn('run_recovery.failed', failure, error);
        });
      } finally {
        await writeFile(PROGRESS_MARKER, String(process.pid)).catch(
          (error: unknown) => {
            reportDiagnostic(() => {
              logger.warn('worker.progress_marker_failed', {}, error);
            });
          },
        );
      }
    },
    cycleFailed: () => {
      logger.error('run_recovery.scan_failed');
    },
    release: () => store.close(),
  });
}

function recoveryEvent(recovery: StalledWorkRecovery): string {
  switch (recovery.kind) {
    case 'attempt_reclaimed':
      return 'run_recovery.attempt_reclaimed';
    case 'attempt_marked_unknown':
      return 'run_recovery.attempt_marked_unknown';
    case 'delivery_replaced':
      return 'run_recovery.delivery_replaced';
    case 'delivery_redelivered':
      return 'run_recovery.delivery_redelivered';
    case 'delivery_given_up':
      return 'run_recovery.delivery_given_up';
  }
}

export function configuredStalledWorkRuntime(
  config: WorkerConfig,
  logger: StructuredLogger,
): StalledWorkRuntime {
  return createStalledWorkRuntime(
    createStalledWorkStore(config.retention.maintenanceDatabase),
    logger,
  );
}
