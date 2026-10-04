import { isDeepStrictEqual } from 'node:util';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

import {
  advanceWorkflow,
  parseCheckpoint,
  type WorkflowTransitionPlan,
  type CompiledWorkflowExecutableV3,
  CallableCompletionStoppedError,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';

import type { CoordinatorAdvanceEngine } from './coordinator-handler.js';
import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from './persisted-workflow-projection.js';

export type CoordinatorAdvanceEngineOptions =
  PersistedWorkflowProjectionVerificationOptions &
    Readonly<{ expressionEvaluator?: ExpressionEvaluator }>;

export function createCoordinatorAdvanceEngine(
  options: CoordinatorAdvanceEngineOptions,
): CoordinatorAdvanceEngine {
  return Object.freeze({
    advance: async (
      input: Parameters<CoordinatorAdvanceEngine['advance']>[0],
    ): ReturnType<CoordinatorAdvanceEngine['advance']> => {
      if (
        input.workflowCalls?.declarations.some(
          ({ artifactSource }) => artifactSource !== undefined,
        )
      )
        throw new TypeError(
          'Coordinator Call declaration requires scoped hydration',
        );
      if (
        input.callableCompletion !== undefined &&
        input.loadCallableCompletion !== undefined
      )
        throw new WorkflowEngineError(
          'observation_invalid',
          'eager and demand completion conflict',
        );
      const previous = parseCheckpoint(input.checkpoint);
      const calleeDeclarations = new Map(
        (input.calleeProjections ?? []).map((projection) => {
          const executable: CompiledWorkflowExecutableV3 =
            verifyPersistedWorkflowProjection(projection, options);
          const declaration = executable.envelope.graph.callable;
          if (declaration === undefined)
            throw new TypeError('Call target is not callable');
          return [projection.id, declaration] as const;
        }),
      );
      const executable = verifyPersistedWorkflowProjection(
        input.projection,
        options,
      );
      let plan: WorkflowTransitionPlan;
      try {
        plan = await advanceWorkflow({
          runId: input.runId,
          workflowVersionId: input.workflowVersionId,
          executable,
          checkpoint: input.checkpoint,
          observations: input.observations,
          completedOutputs: input.completedOutputs,
          ...(input.callableCompletion === undefined
            ? {}
            : {
                callableCompletion: {
                  ...input.callableCompletion,
                  ...(options.expressionEvaluator === undefined
                    ? {}
                    : { expressionEvaluator: options.expressionEvaluator }),
                },
              }),
          ...(!('callable' in executable.envelope.graph) ||
          executable.envelope.graph.callable === undefined ||
          input.loadCallableCompletion === undefined
            ? {}
            : { loadCallableCompletion: input.loadCallableCompletion }),
          ...(options.expressionEvaluator === undefined
            ? {}
            : { callableExpressionEvaluator: options.expressionEvaluator }),
          ...(input.workflowCalls === undefined
            ? {}
            : {
                workflowCalls: {
                  declarations: input.workflowCalls.declarations,
                  facts: input.workflowCalls.facts,
                  calleeDeclarations,
                },
              }),
          occurredAt: input.occurredAt,
          maximumAdmissions: input.maximumAdmissions,
          signal: input.signal,
        });
      } catch (error: unknown) {
        if (error instanceof CallableCompletionStoppedError)
          return Object.freeze({
            kind: 'value_work_stopped' as const,
            stop: error.stop,
          });
        throw error;
      }
      const previousAtNextRevision = Object.freeze({
        ...previous,
        revision: plan.checkpoint.revision,
      });
      if (
        plan.events.length === 0 &&
        plan.nodeRunAdmissions.length === 0 &&
        plan.attempts.length === 0 &&
        plan.callableResult === undefined &&
        (plan.workflowCalls === undefined ||
          (plan.workflowCalls.declarations.length === 0 &&
            plan.workflowCalls.cancelChildren.length === 0)) &&
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
