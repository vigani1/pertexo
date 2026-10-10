import type {
  PublishedWorkflow,
  RunAdvanceDecision,
} from '@pertexo/database/runs';
import { parseCheckpoint } from '@pertexo/workflow-engine';

import { advanceRun } from '../../src/runs/advance-run.js';
import type { PersistedWorkflowProjectionVerificationOptions } from '../../src/workflows/verify-projection.js';

type DecideInput = Readonly<{
  runId: string;
  workflowVersionId: string;
  projection: PublishedWorkflow;
  checkpoint: unknown;
  observations: readonly unknown[];
  completedOutputs?: readonly unknown[];
  occurredAt: string;
  maximumAdmissions: number;
  signal: AbortSignal;
}>;

/** Runs `advanceRun` against an in-memory store and returns what it decided. */
export function createDecisionEngine(
  verification: PersistedWorkflowProjectionVerificationOptions,
) {
  return Object.freeze({
    advance: async (input: DecideInput) => {
      let decision: RunAdvanceDecision | undefined;
      await advanceRun(
        {
          runs: {
            advance: async (_input, decide) => {
              decision = await decide({
                runId: input.runId,
                workflowVersionId: input.workflowVersionId,
                checkpoint: input.checkpoint,
                observations: input.observations,
                completedOutputs: input.completedOutputs ?? [],
                workflow: input.projection,
                readCompletionValues: () =>
                  Promise.resolve({
                    runInput: undefined,
                    outputs: [],
                  }),
              });
              return { kind: 'no_change', revision: 0 };
            },
            close: () => Promise.resolve(),
          },
          verification,
          maximumAdmissions: input.maximumAdmissions,
          now: () => input.occurredAt,
        },
        {
          delivery: {
            outboxEventId: '55555555-5555-4555-8555-555555555555',
            payloadChecksum: 'a'.repeat(64),
          },
          workspaceId: input.projection.workspaceId,
          runId: input.runId,
          signal: input.signal,
        },
      );
      if (decision === undefined) throw new Error('advanceRun did not decide');
      return decision.kind === 'no_change'
        ? {
            kind: 'no_change' as const,
            revision: parseCheckpoint(input.checkpoint).revision,
          }
        : { kind: 'transition' as const, plan: decision.plan };
    },
  });
}
