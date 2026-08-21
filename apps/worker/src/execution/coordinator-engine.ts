import { isDeepStrictEqual } from 'node:util';

import type { PublishedWorkflowV2Projection } from '@pertexo/database';
import {
  advanceWorkflow,
  parseCheckpoint,
  verifyWorkflowExecutableV2,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';

import type { CoordinatorAdvanceEngine } from './coordinator-handler.js';

export type CoordinatorAdvanceEngineOptions = Readonly<{
  admissionRelease: unknown;
  currentRelease?: unknown;
}>;

function verifyProjection(
  projection: PublishedWorkflowV2Projection,
  options: CoordinatorAdvanceEngineOptions,
) {
  const executable = verifyWorkflowExecutableV2({
    envelope: projection.executableJson,
    checksum: projection.checksum,
    admissionRelease: options.admissionRelease,
    ...(options.currentRelease === undefined
      ? {}
      : { currentRelease: options.currentRelease }),
    execution: { alreadyAdmitted: true },
  });
  if (
    executable.envelope.compatibilityReleaseEpoch !==
    projection.compatibilityReleaseEpoch
  ) {
    throw new TypeError(
      'Published workflow compatibility release epoch does not match its executable envelope',
    );
  }
  return executable;
}

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
        executable: verifyProjection(input.projection, options),
        checkpoint: input.checkpoint,
        observations: input.observations,
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
