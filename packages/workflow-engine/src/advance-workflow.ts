import { WorkflowEngineError } from './errors.js';
import type { SchedulerState } from './graph-scheduler.js';
import type {
  BranchLedgerEntry,
  BranchScopePart,
  IterationScopePart,
  JoinPolicy,
  NodeStatus,
  OutputReference,
  WorkflowCheckpoint,
  WorkflowTransitionPlan,
} from './types.js';
import { deriveWorkflowTransitions } from './workflow-transition-derived.js';
import { applyWorkflowObservations } from './workflow-transition-observations.js';
import { buildWorkflowTransitionPlan } from './workflow-transition-plan.js';
import {
  observationOrder,
  rootInvocationKey,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';
import { applyWorkflowStops } from './workflow-transition-stops.js';

export type WorkflowObservation =
  | { readonly kind: 'cursor_only' }
  | {
      readonly kind: 'ready';
      readonly invocationKey: string;
      readonly nodeId: string;
      readonly branchPath?: readonly BranchScopePart[];
      readonly iterationPath?: readonly IterationScopePart[];
    }
  | {
      readonly kind: 'outcome';
      readonly invocationKey: string;
      readonly status: Extract<
        NodeStatus,
        | 'succeeded'
        | 'failed'
        | 'canceled'
        | 'timed_out'
        | 'outcome_unknown'
        | 'skipped'
      >;
      readonly output?: OutputReference;
      readonly reasonCode?: string;
      readonly coordinatorDerived?: boolean;
    }
  | {
      readonly kind: 'wait';
      readonly invocationKey: string;
      readonly resumeAt: string;
      readonly waitKind: 'node_wait' | 'retry_backoff';
      readonly output?: OutputReference;
      readonly coordinatorDerived?: boolean;
    }
  | { readonly kind: 'resume'; readonly invocationKey: string }
  | { readonly kind: 'cancel_requested' }
  | { readonly kind: 'deadline_expired'; readonly occurredAt?: string }
  | {
      readonly kind: 'branch_selected';
      readonly invocationKey: string;
      readonly nodeId: string;
      readonly selectedOutputPort: string;
      readonly coordinatorDerived?: true;
    }
  | {
      readonly kind: 'join_declared';
      readonly joinId: string;
      readonly joinInvocationKey?: string;
      readonly branchPath?: readonly BranchScopePart[];
      readonly iterationPath?: readonly IterationScopePart[];
      readonly policy: JoinPolicy;
      readonly branchIds: readonly string[];
      readonly coordinatorDerived?: true;
    }
  | {
      readonly kind: 'branch_disposition';
      readonly joinId: string;
      readonly joinInvocationKey?: string;
      readonly branch: BranchLedgerEntry;
      readonly coordinatorDerived?: true;
    }
  | {
      readonly kind: 'loop_started';
      readonly loopId: string;
      readonly controlInvocationKey?: string;
      readonly branchPath?: readonly BranchScopePart[];
      readonly iterationPath?: readonly IterationScopePart[];
      readonly bodyRootNodeIds?: readonly string[];
      readonly bodySinkNodeId?: string;
      readonly coordinatorDerived?: true;
      readonly collection: OutputReference;
      readonly collectionChecksum: string;
      readonly collectionSize: number;
      readonly maxIterations: number;
      readonly maxConcurrency: number;
    }
  | {
      readonly kind: 'loop_iteration_completed';
      readonly loopId: string;
      readonly controlInvocationKey?: string;
      readonly invocationKey?: string;
      readonly ordinal: number;
      readonly status?: Extract<
        NodeStatus,
        | 'succeeded'
        | 'skipped'
        | 'failed'
        | 'canceled'
        | 'timed_out'
        | 'outcome_unknown'
      >;
      readonly output?: OutputReference;
      readonly reasonCode?: string;
      readonly coordinatorDerived?: true;
    };

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
    invocations: new Map(
      current.invocations.map((invocation) => [
        invocation.invocationKey,
        invocation,
      ]),
    ),
    joins: new Map(
      current.joins.map((join) => [
        join.joinInvocationKey === undefined ||
        join.joinInvocationKey === join.joinId
          ? rootInvocationKey(current.workflowVersionId, join.joinId)
          : join.joinInvocationKey,
        join,
      ]),
    ),
    loops: new Map(
      current.loops.map((loop) => [loop.controlInvocationKey, loop]),
    ),
    branchSelections:
      current.schemaVersion === 2 ? [...current.branchSelections] : [],
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
