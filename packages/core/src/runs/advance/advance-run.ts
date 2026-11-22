import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';
import { prepareStoredExecutionValue } from '../../shared/stored-execution.js';
import type { JsonValue } from '@pertexo/workflow-model';
import { generatePersistedId } from '@pertexo/database/platform';
import type {
  AgentModelRates,
  InlineAdvanceOptions,
} from '@pertexo/workflow-engine/server';
import { decodeStoredValue } from '../../shared/stored-values.js';
import { isDeepStrictEqual } from 'node:util';

import type { RunAdvanceInput, RunAdvanceResult } from './run-advance.types.js';
import type { RunAdvanceStore } from './run-advance.store.js';
import type { WorkflowCallStore } from '../calls/workflow-call.store.js';
import { WorkflowCallRefusedError } from '../calls/workflow-call.errors.js';
import { createInitialCheckpoint } from '../commands/create-initial-checkpoint.js';
import {
  advanceWorkflow,
  parseCheckpoint,
  settleCallableResult,
} from '@pertexo/workflow-engine/server';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';
import { resolveRunResult } from './resolve-result.js';

import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../queries/execution/verify-projection.js';

export type AdvanceRunDependencies = Readonly<{
  agentModelRates?: (model: string) => AgentModelRates | undefined;
  runs: RunAdvanceStore;
  calls: WorkflowCallStore;
  verification: PersistedWorkflowProjectionVerificationOptions;
  /** Most node attempts one transition may admit. */
  maximumAdmissions: number;
  expressionEvaluator?: ExpressionEvaluator;
  inline?: Pick<InlineAdvanceOptions, 'registry' | 'normalizeFailure'>;
}>;

/**
 * Moves a run forward: in one transaction the run is locked, the engine
 * decides what happens next from its checkpoint and new facts, and the
 * decision is saved.
 */
export async function advanceRun(
  dependencies: AdvanceRunDependencies,
  input: RunAdvanceInput,
): Promise<RunAdvanceResult> {
  await dependencies.calls.performActions(input, (projection) => {
    const initial = createInitialCheckpoint(
      projection,
      dependencies.verification,
    );
    if (initial.validateInput === undefined)
      throw new WorkflowCallRefusedError('call_target_not_callable');
    return initial;
  });
  return dependencies.runs.advance(input, async (state) => {
    const previous = decodeStoredValue(() => parseCheckpoint(state.checkpoint));
    const executable = verifyPersistedWorkflowProjection(
      state.workflow,
      dependencies.verification,
    );
    let plan = await advanceWorkflow({
      runId: state.runId,
      workflowVersionId: state.workflowVersionId,
      executable,
      checkpoint: state.checkpoint,
      observations: state.observations,
      completedOutputs: state.completedOutputs,
      callOutcomes: state.callOutcomes,
      taskOutcomes: state.taskOutcomes,
      hasExecutionSlot: state.hasExecutionSlot,
      occurredAt: state.occurredAt,
      maximumAdmissions: dependencies.maximumAdmissions,
      ...(dependencies.agentModelRates === undefined
        ? {}
        : {
            agentModelRates: dependencies.agentModelRates,
          }),
      ...(state.workflow.test === undefined
        ? {}
        : { test: state.workflow.test }),
      ...(dependencies.inline === undefined ||
      state.readInlineValues === undefined
        ? {}
        : {
            inline: {
              ...dependencies.inline,
              now: Date.now,
              monotonicNow: () => performance.now(),
              newAttemptId: generatePersistedId,
              canStore: canStoreInlineValue,
              readValues: state.readInlineValues,
              ...(state.reacquiredExecutionSlot
                ? { deferUntilNextAdvance: true }
                : {}),
              ...(state.deadlineAt === undefined
                ? {}
                : { deadlineAt: state.deadlineAt }),
              ...(dependencies.expressionEvaluator === undefined
                ? {}
                : { expressionEvaluator: dependencies.expressionEvaluator }),
            },
          }),
      signal: input.signal,
    });
    const callable = executable.envelope.graph.callable;
    if (
      callable !== undefined &&
      plan.events.some(({ name }) => name === 'run.succeeded')
    )
      plan = settleCallableResult(
        plan,
        await resolveRunResult(
          callable,
          {
            ...state,
            inlineAttempts: plan.inlineAttempts,
            agentOutputs: plan.agentOutputs,
          },
          input.signal,
          dependencies.expressionEvaluator,
        ),
      );
    const unchanged =
      plan.events.length === 0 &&
      plan.nodeRunAdmissions.length === 0 &&
      plan.attempts.length === 0 &&
      !plan.immediateContinuation &&
      isDeepStrictEqual(
        { ...previous, revision: plan.checkpoint.revision },
        plan.checkpoint,
      );
    return unchanged
      ? { kind: 'no_change' }
      : { kind: 'transition', previous, plan };
  });
}

function canStoreInlineValue(value: JsonValue): boolean {
  try {
    prepareStoredExecutionValue({ kind: 'inline', value });
    return true;
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError) return false;
    throw error;
  }
}
