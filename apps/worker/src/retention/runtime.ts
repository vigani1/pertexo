import type {
  PreviewRetentionCoordinator,
  RetentionStore,
  RunArtifactRetentionCoordinator,
  WorkspacePurgeCoordinator,
} from '@pertexo/core/lifecycle';
import type { StructuredLogger } from '@pertexo/observability';

import {
  createPollingRuntime,
  reportDiagnostic,
  type PollingRuntime,
} from '../runtime/polling.js';
import type { RetentionMetrics, RetentionOperation } from './metrics.js';

export type RetentionRuntime = PollingRuntime;

export const RETENTION_RUNTIME = Symbol('RETENTION_RUNTIME');

export type RetentionRuntimeResources = Readonly<{
  database: RetentionStore;
  preview: PreviewRetentionCoordinator;
  runArtifacts: RunArtifactRetentionCoordinator;
  workspacePurge: WorkspacePurgeCoordinator;
  /** Closes resources the coordinators share, such as the database pool. */
  release(): Promise<void>;
}>;

/** One call does a bounded unit of work and says whether more is ready now. */
type RetentionOperationStep = (signal: AbortSignal) => Promise<boolean>;

/** Repeats an operation back to back while it has work, then yields. */
const MAX_STEPS_PER_OPERATION = 20;

/**
 * Retention windows are days long, so a pass needn't run every poll: all its
 * rules together are about 50 transactions. A full page brings the next one
 * straight back. A failed pass retries on the next poll, as other operations do.
 */
const RULE_PASS_MILLIS = 5 * 60 * 1_000;

/**
 * Retention rules, preview and artifact cleanup and workspace purge. Every
 * worker may run it; locks in the database keep the work disjoint. A failing
 * operation is logged and retried on the next cycle without stopping the
 * others or the worker.
 */
export function createRetentionRuntime(
  resources: RetentionRuntimeResources,
  metrics: RetentionMetrics,
  logger: StructuredLogger,
  pollMillis: number,
): RetentionRuntime {
  const timed = async <T>(
    work: () => Promise<T>,
    record: (result: T, durationSeconds: number) => void,
  ): Promise<T> => {
    const startedAt = performance.now();
    const result = await work();
    reportDiagnostic(() => {
      record(result, (performance.now() - startedAt) / 1_000);
    });
    return result;
  };

  let nextRulePassAt = 0;

  const operations: readonly (readonly [
    RetentionOperation,
    RetentionOperationStep,
  ])[] = [
    [
      'retention',
      async (signal) => {
        if (performance.now() < nextRulePassAt) return false;
        const result = await timed(
          () => resources.database.enforce(signal),
          (result, seconds) => {
            metrics.recordRetention(result, seconds);
          },
        );
        nextRulePassAt = result.more ? 0 : performance.now() + RULE_PASS_MILLIS;
        return result.more;
      },
    ],
    [
      'preview',
      async (signal) => {
        const { status } = await timed(
          () => resources.preview.processNext(signal),
          (result, seconds) => {
            metrics.recordPreview(result, seconds);
          },
        );
        return status === 'completed' || status === 'progressed';
      },
    ],
    [
      'run_artifact',
      async (signal) =>
        (
          await timed(
            () => resources.runArtifacts.processNext(signal),
            (result, seconds) => {
              metrics.recordRunArtifact(result, seconds);
            },
          )
        ).status === 'completed',
    ],
    [
      'workspace_purge',
      async (signal) => {
        const { status } = await timed(
          () => resources.workspacePurge.processNext(signal),
          (result, seconds) => {
            metrics.recordWorkspacePurge(result, seconds);
          },
        );
        return status === 'started' || status === 'progressed';
      },
    ],
  ];

  const run = async (
    operation: RetentionOperation,
    step: RetentionOperationStep,
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = performance.now();
    try {
      for (let count = 0; count < MAX_STEPS_PER_OPERATION; count += 1)
        if (!(await step(signal))) return;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      reportDiagnostic(() => {
        metrics.recordFailure(
          operation,
          (performance.now() - startedAt) / 1_000,
        );
        logger.error('retention.operation_failed', { operation }, error);
      });
    }
  };

  return createPollingRuntime({
    name: 'Retention',
    pollMillis,
    checkStore: async (signal) => {
      await resources.database.checkReadiness(signal);
    },
    cycle: async (signal) => {
      for (const [operation, step] of operations)
        await run(operation, step, signal);
    },
    cycleFailed: () => {
      logger.error('retention.cycle_failed', {});
    },
    release: async () => {
      const closed = await Promise.allSettled([
        resources.preview.close(),
        resources.runArtifacts.close(),
        resources.workspacePurge.close(),
        resources.database.close(),
      ]);
      const failures = closed.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      try {
        await resources.release();
      } catch (error: unknown) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Retention shutdown failed');
    },
  });
}
