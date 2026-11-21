import type { InlineAttemptSettlement } from '../attempt/inline-settlement.types.js';
import { WorkflowEngineError } from '../workflow-engine.errors.js';
import type { SchedulerState } from './scheduling/policy.js';
import type {
  WorkflowCheckpoint,
  WorkflowObservation,
  WorkflowTransitionPlan,
} from '../workflow-execution.js';
import { deriveWorkflowTransitions } from './derived.js';
import { applyWorkflowObservations } from './observations.js';
import { buildWorkflowTransitionPlan } from './plan.js';
import {
  observationOrder,
  indexTransitionNodes,
  type MutableWorkflowTransition,
} from './transition-state.js';
import { settleFailureHandlers } from '../failure-routing/selection.js';
import { applyWorkflowStops } from './stops.js';

export interface AdvanceWorkflowFromSchedulerStateInput {
  readonly checkpoint: WorkflowCheckpoint;
  readonly schedulerState?: SchedulerState;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  readonly hasExecutionSlot?: boolean;
  /** Production source facts are already durable events and must not be emitted again. */
  readonly persistedObservationCursor?: Readonly<{
    expectedNextEventSequence: number;
    consumedThroughEventSequence: number;
  }>;
  readonly deadlineExpiration?: Readonly<{ readonly occurredAt: string }>;
  readonly dueResumptions?: readonly Readonly<{
    readonly invocationKey: string;
    readonly occurredAt: string;
  }>[];
}

export function advanceWorkflowFromSchedulerState(
  input: AdvanceWorkflowFromSchedulerStateInput,
): WorkflowTransitionPlan {
  const { state, finish } = prepareWorkflowAdvance(input);
  return finish(state);
}

export function prepareWorkflowAdvance(
  input: AdvanceWorkflowFromSchedulerStateInput,
) {
  if (
    !Number.isSafeInteger(input.maximumAdmissions) ||
    input.maximumAdmissions < 0
  )
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'maximumAdmissions must be non-negative',
    );
  const current = input.checkpoint;
  const externalFactsArePersisted =
    input.persistedObservationCursor !== undefined;
  if (
    input.persistedObservationCursor !== undefined &&
    input.persistedObservationCursor.expectedNextEventSequence !==
      current.nextEventSequence
  )
    throw new WorkflowEngineError(
      'observation_invalid',
      'persisted observation cursor does not match checkpoint',
    );
  const consumedThroughEventSequence =
    input.persistedObservationCursor?.consumedThroughEventSequence ??
    current.nextEventSequence - 1;
  const consumedObservationCount =
    consumedThroughEventSequence - current.nextEventSequence + 1;
  const invalidCursor =
    consumedObservationCount < 0 ||
    (externalFactsArePersisted &&
      consumedObservationCount !==
        (input.observations ?? []).filter(
          (observation) =>
            !('coordinatorDerived' in observation) ||
            !observation.coordinatorDerived,
        ).length);
  if (invalidCursor)
    throw new WorkflowEngineError(
      'observation_invalid',
      'persisted observation cursor is invalid',
    );

  const state: MutableWorkflowTransition = {
    current,
    graph: input.schedulerState,
    schedulerNodes: indexTransitionNodes(input.schedulerState),
    invocations: new Map(
      current.invocations.map((invocation) => [
        invocation.invocationKey,
        invocation,
      ]),
    ),
    joins: new Map(current.joins.map((join) => [join.joinInvocationKey, join])),
    loops: new Map(
      current.loops.map((loop) => [loop.controlInvocationKey, loop]),
    ),
    branchSelections: [...current.branchSelections],
    remainingIterationBudget: current.remainingIterationBudget,
    failureValues: [],
    eventDrafts: [],
    nodeRunAdmissionKeys: new Set(),
    externalFactsArePersisted,
    cancelRequested: current.cancelRequested,
    deadlineExpired:
      current.deadlineExpired || input.deadlineExpiration !== undefined,
    deadlineOccurredAt: input.deadlineExpiration?.occurredAt,
    runStatus: current.runStatus,
  };
  const observations = externalFactsArePersisted
    ? [...(input.observations ?? [])]
    : [...(input.observations ?? [])].sort(observationOrder);
  const coordinatorNodeIds = new Set([
    ...current.joins.map(({ joinId }) => joinId),
    ...current.loops.map(({ loopId }) => loopId),
    ...observations.flatMap(coordinatorNodeId),
  ]);
  const apply = (
    facts: readonly WorkflowObservation[],
    occurredAt: string,
    dueResumptions: NonNullable<typeof input.dueResumptions> = [],
  ) => {
    for (const fact of facts)
      for (const id of coordinatorNodeId(fact)) coordinatorNodeIds.add(id);
    applyWorkflowObservations(state, {
      dueResumptions,
      observations: facts,
      occurredAt,
    });
    settleFailureHandlers(state, occurredAt);
    deriveWorkflowTransitions(state, { coordinatorNodeIds, occurredAt });
    applyWorkflowStops(state, occurredAt);
  };
  apply(observations, input.occurredAt, input.dueResumptions);
  return {
    state,
    apply,
    finish: (
      working: MutableWorkflowTransition,
      {
        inlineAttempts,
        attemptKeys,
        yieldInline,
        occurredAt = input.occurredAt,
      }: Readonly<{
        inlineAttempts?: readonly InlineAttemptSettlement[];
        attemptKeys?: readonly string[];
        yieldInline?: boolean;
        occurredAt?: string;
      }> = {},
    ) =>
      buildWorkflowTransitionPlan(working, {
        consumedObservationCount,
        consumedThroughEventSequence,
        maximumAdmissions: input.maximumAdmissions,
        hasExecutionSlot: input.hasExecutionSlot ?? true,
        occurredAt,
        ...(inlineAttempts === undefined ? {} : { inlineAttempts }),
        ...(yieldInline === undefined ? {} : { yieldInline }),
        ...(attemptKeys === undefined ? {} : { attemptKeys }),
      }),
  };
}

function coordinatorNodeId(
  observation: WorkflowObservation,
): readonly string[] {
  if (observation.kind === 'join_declared') return [observation.joinId];
  if (observation.kind === 'loop_started') return [observation.loopId];
  return [];
}
