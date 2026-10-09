import { isDeepStrictEqual } from 'node:util';

import type {
  RunAdvanceInput,
  RunAdvanceResult,
  RunAdvanceStore,
} from '@pertexo/database/runs';
import { advanceWorkflow, parseCheckpoint } from '@pertexo/workflow-engine';

import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../workflows/verify-projection.js';

export type AdvanceRunDependencies = Readonly<{
  runs: RunAdvanceStore;
  verification: PersistedWorkflowProjectionVerificationOptions;
  /** Most node attempts one transition may admit. */
  maximumAdmissions: number;
  now(): string;
}>;

/**
 * Moves a run forward: in one transaction the run is locked, the engine
 * decides what happens next from its checkpoint and new facts, and the
 * decision is saved.
 */
export function advanceRun(
  dependencies: AdvanceRunDependencies,
  input: RunAdvanceInput,
): Promise<RunAdvanceResult> {
  return dependencies.runs.advance(input, async (state) => {
    const previous = parseCheckpoint(state.checkpoint);
    const plan = await advanceWorkflow({
      runId: state.runId,
      workflowVersionId: state.workflowVersionId,
      executable: verifyPersistedWorkflowProjection(
        state.workflow,
        dependencies.verification,
      ),
      checkpoint: state.checkpoint,
      observations: state.observations,
      completedOutputs: state.completedOutputs,
      occurredAt: dependencies.now(),
      maximumAdmissions: dependencies.maximumAdmissions,
      signal: input.signal,
    });
    const unchanged =
      plan.events.length === 0 &&
      plan.nodeRunAdmissions.length === 0 &&
      plan.attempts.length === 0 &&
      isDeepStrictEqual(
        { ...previous, revision: plan.checkpoint.revision },
        plan.checkpoint,
      );
    return unchanged
      ? { kind: 'no_change' }
      : { kind: 'transition', previous, plan };
  });
}
