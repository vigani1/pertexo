import { advanceWorkflowFromSchedulerState } from '../../src/transition/advance.js';
import { parseCheckpoint } from '../../src/checkpoint/create-and-parse.js';
import {
  configuredParallelOutputPorts,
  deriveReadyNodes,
} from '../../src/transition/scheduling/readiness.js';
import { parseSchedulerGraph, type SchedulerGraph } from './scheduler-graph.js';
import type {
  WorkflowObservation,
  WorkflowTransitionPlan,
} from '../../src/types.js';

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
export type { ReadyNodeDecision } from '../../src/transition/scheduling/readiness.js';
export {
  admitLoopIterations,
  completeLoopIteration,
  createLoopState,
  recordBranchDisposition,
  settleJoin,
} from '../../src/transition/scheduling/loops.js';
export type {
  JoinDecision,
  LoopAdmission,
} from '../../src/transition/scheduling/loops.js';
export {
  decideRetry,
  ENGINE_RETRY_POLICY,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from '../../src/attempt/retries.js';
export type {
  AttemptObservation,
  RetryDecision,
  RetryPolicy,
} from '../../src/attempt/retries.js';
export {
  assertNodeTransition,
  assertRunTransition,
} from '../../src/transition/status-transitions.js';
export { NODE_STATUSES, RUN_STATUSES } from '../../src/types.js';
export * from '../../src/index.js';
