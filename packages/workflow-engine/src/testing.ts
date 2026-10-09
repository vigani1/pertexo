import './server-only.js';

import { advanceWorkflowFromSchedulerState } from './transition/advance-workflow.js';
import { parseCheckpoint } from './checkpoint/checkpoint.js';
import {
  configuredParallelOutputPorts,
  deriveReadyNodes,
} from './transition/graph-scheduler.js';
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

export { configuredParallelOutputPorts, deriveReadyNodes, parseSchedulerGraph };
export type { SchedulerGraph, WorkflowObservation };
export type { ReadyNodeDecision } from './transition/graph-scheduler.js';
export {
  admitLoopIterations,
  completeLoopIteration,
  createLoopState,
  recordBranchDisposition,
  settleJoin,
} from './transition/scheduling.js';
export type { JoinDecision, LoopAdmission } from './transition/scheduling.js';
export {
  decideRetry,
  ENGINE_RETRY_POLICY_V1,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from './attempt/retries.js';
export type {
  AttemptObservation,
  RetryDecision,
  RetryPolicy,
} from './attempt/retries.js';
export {
  assertNodeTransition,
  assertRunTransition,
} from './transition/transitions.js';
export { NODE_STATUSES, RUN_STATUSES } from './types.js';
export * from './index.js';
