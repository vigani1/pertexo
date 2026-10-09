import { metrics, type Meter } from '@opentelemetry/api';
import type {
  WorkflowTriggerPauseDecision,
  WorkflowTriggerPauseFoldStore,
} from '@pertexo/database/triggers';

import {
  createPollingRuntime,
  reportDiagnostic,
  type PollingRuntime,
} from '../runtime/polling.js';

export type WorkflowAutoPauseRuntime = PollingRuntime;

export const WORKFLOW_AUTO_PAUSE_RUNTIME = Symbol(
  'WORKFLOW_AUTO_PAUSE_RUNTIME',
);

export type WorkflowAutoPauseRuntimeOptions = Readonly<{
  foldBatchSize: number;
  foldPollMillis: number;
}>;

export type WorkflowAutoPauseDiagnostics = Readonly<{
  cycleFailed(): void;
  decided(decision: WorkflowTriggerPauseDecision): void;
}>;

/** Folds back to back while a burst is pending, then yields to the poll. */
const MAX_FOLDS_PER_CYCLE = 20;

/**
 * ADR 056: folds schedule and webhook run outcomes into failure streaks and
 * pauses workflows that reach their threshold. Every worker may run it; the
 * database command takes disjoint work.
 */
export function createWorkflowAutoPauseRuntime(
  store: WorkflowTriggerPauseFoldStore,
  options: WorkflowAutoPauseRuntimeOptions,
  diagnostics: WorkflowAutoPauseDiagnostics,
  meter: Meter = metrics.getMeter('@pertexo/worker.auto-pause', '0.0.0'),
): WorkflowAutoPauseRuntime {
  const decisions = meter.createCounter(
    'pertexo.workflow.auto_pause.decision.count',
    {
      description: 'Workflows paused after consecutive failures',
      unit: '{workflow}',
    },
  );
  return createPollingRuntime({
    name: 'Workflow auto-pause',
    pollMillis: options.foldPollMillis,
    checkStore: (signal) => store.checkReadiness(signal),
    cycle: async (signal) => {
      for (let round = 0; round < MAX_FOLDS_PER_CYCLE; round += 1) {
        const decided = await store.foldPending(options.foldBatchSize, signal);
        for (const decision of decided) {
          decisions.add(1, { outcome: 'paused' });
          reportDiagnostic(() => {
            diagnostics.decided(decision);
          });
        }
        if (decided.length === 0) return;
      }
    },
    cycleFailed: diagnostics.cycleFailed,
    release: () => store.close(),
  });
}
