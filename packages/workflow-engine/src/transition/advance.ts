import { WorkflowEngineError } from '../errors.js';
import type { SchedulerState } from './scheduling/readiness.js';
import type {
  WorkflowCheckpoint,
  WorkflowObservation,
  WorkflowTransitionPlan,
} from '../types.js';
import { deriveWorkflowTransitions } from './derived.js';
import { applyWorkflowObservations } from './observations.js';
import { buildWorkflowTransitionPlan } from './plan.js';
import {
  observationOrder,
  indexTransitionNodes,
  type MutableWorkflowTransition,
} from './state.js';
import { applyWorkflowStops } from './stops.js';

export interface AdvanceWorkflowFromSchedulerStateInput {
  readonly checkpoint: WorkflowCheckpoint;
  readonly schedulerState?: SchedulerState;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
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
  if (
    consumedObservationCount < 0 ||
    (externalFactsArePersisted &&
      consumedObservationCount !==
        (input.observations ?? []).filter(
          (observation) =>
            !('coordinatorDerived' in observation) ||
            !observation.coordinatorDerived,
        ).length)
  )
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
  applyWorkflowObservations(state, {
    dueResumptions: input.dueResumptions ?? [],
    observations,
    occurredAt: input.occurredAt,
  });
  const coordinatorNodeIds = new Set([
    ...current.joins.map(({ joinId }) => joinId),
    ...current.loops.map(({ loopId }) => loopId),
    ...observations.flatMap((observation) =>
      observation.kind === 'join_declared'
        ? [observation.joinId]
        : observation.kind === 'loop_started'
          ? [observation.loopId]
          : [],
    ),
  ]);
  deriveWorkflowTransitions(state, {
    coordinatorNodeIds,
    occurredAt: input.occurredAt,
  });
  applyWorkflowStops(state, input.occurredAt);
  return buildWorkflowTransitionPlan(state, {
    consumedObservationCount,
    consumedThroughEventSequence,
    maximumAdmissions: input.maximumAdmissions,
    occurredAt: input.occurredAt,
  });
}
