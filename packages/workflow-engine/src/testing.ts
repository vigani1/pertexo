import './server-only.js';

import { advanceWorkflowFromSchedulerState } from './advance-workflow.js';
import { parseCheckpoint } from './checkpoint.js';
import { deriveReadyNodes } from './graph-scheduler.js';
import { parseSchedulerGraph, type SchedulerGraph } from './testing-graph.js';
import type { WorkflowObservation, WorkflowTransitionPlan } from './types.js';

export interface AdvanceWorkflowInput {
  readonly checkpoint: unknown;
  readonly graph?: unknown;
  readonly schedulerState?: SchedulerGraph;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  /** Durable observation-window facts supplied by the coordinator adapter. */
  readonly persistedObservationCursor?: Readonly<{
    readonly expectedNextEventSequence: number;
    readonly consumedThroughEventSequence: number;
  }>;
  readonly dueResumptions?: readonly Readonly<{
    readonly invocationKey: string;
    readonly occurredAt: string;
  }>[];
}

export function advanceWorkflow(
  input: AdvanceWorkflowInput,
): WorkflowTransitionPlan {
  if (input.graph !== undefined && input.schedulerState !== undefined)
    throw new Error('provide graph or schedulerState, not both');
  return advanceWorkflowFromSchedulerState({
    checkpoint: parseCheckpoint(input.checkpoint),
    ...(input.schedulerState !== undefined
      ? { schedulerState: input.schedulerState }
      : input.graph !== undefined
        ? { schedulerState: parseSchedulerGraph(input.graph) }
        : {}),
    ...(input.observations === undefined
      ? {}
      : { observations: input.observations }),
    occurredAt: input.occurredAt,
    maximumAdmissions: input.maximumAdmissions,
    ...(input.persistedObservationCursor === undefined
      ? {}
      : { persistedObservationCursor: input.persistedObservationCursor }),
    ...(input.dueResumptions === undefined
      ? {}
      : { dueResumptions: input.dueResumptions }),
  });
}

export { deriveReadyNodes, parseSchedulerGraph };
export type { SchedulerGraph, WorkflowObservation };
export type { ReadyNodeDecision } from './graph-scheduler.js';
export {
  admitLoopIterations,
  completeLoopIteration,
  createLoopState,
  recordBranchDisposition,
  settleJoin,
} from './scheduling.js';
export type { JoinDecision, LoopAdmission } from './scheduling.js';
export {
  decideRetry,
  ENGINE_RETRY_POLICY_V1,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from './retries.js';
export type {
  AttemptObservation,
  RetryDecision,
  RetryPolicy,
} from './retries.js';
export { decideCancellation, planDurableWait } from './runtime.js';
export type { CancellationDecision, DurableWaitPlan } from './runtime.js';
export {
  assertAttemptTransition,
  assertNodeTransition,
  assertRunTransition,
} from './transitions.js';
export { ATTEMPT_STATUSES, NODE_STATUSES, RUN_STATUSES } from './types.js';
export * from './index.js';
