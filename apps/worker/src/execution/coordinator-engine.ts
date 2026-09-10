import { isDeepStrictEqual } from 'node:util';

import {
  advanceWorkflow,
  parseCheckpoint,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';

import type { CoordinatorAdvanceEngine } from './coordinator-handler.js';
import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from './persisted-workflow-projection.js';

export type CoordinatorAdvanceEngineOptions =
  PersistedWorkflowProjectionVerificationOptions;

export function createCoordinatorAdvanceEngine(
  options: CoordinatorAdvanceEngineOptions,
): CoordinatorAdvanceEngine {
  return Object.freeze({
    advance: async (
      input: Parameters<CoordinatorAdvanceEngine['advance']>[0],
    ): ReturnType<CoordinatorAdvanceEngine['advance']> => {
      const previous = parseCheckpoint(input.checkpoint);
      const plan: WorkflowTransitionPlan = await advanceWorkflow({
        runId: input.runId,
        workflowVersionId: input.workflowVersionId,
        executable: verifyPersistedWorkflowProjection(
          input.projection,
          options,
        ),
        checkpoint: input.checkpoint,
        observations: input.observations,
        completedOutputs: input.completedOutputs,
        occurredAt: input.occurredAt,
        maximumAdmissions: input.maximumAdmissions,
        signal: input.signal,
      });
      const previousAtNextRevision = Object.freeze({
        ...previous,
        revision: plan.checkpoint.revision,
      });
      if (
        plan.events.length === 0 &&
        plan.nodeRunAdmissions.length === 0 &&
        plan.attempts.length === 0 &&
        isDeepStrictEqual(previousAtNextRevision, plan.checkpoint)
      ) {
        return Object.freeze({
          kind: 'no_change' as const,
          revision: previous.revision,
        });
      }
      return Object.freeze({ kind: 'transition' as const, plan });
    },
  });
}
