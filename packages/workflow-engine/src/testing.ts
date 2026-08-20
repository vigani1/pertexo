import './server-only.js';

import {
  advanceWorkflowFromSchedulerState,
  type WorkflowObservation,
} from './advance-workflow.js';
import { parseCheckpoint } from './checkpoint.js';
import { deriveReadyNodes } from './graph-scheduler.js';
import { parseSchedulerGraph, type SchedulerGraph } from './testing-graph.js';
import type { WorkflowTransitionPlan } from './types.js';

export interface AdvanceWorkflowInput {
  readonly checkpoint: unknown;
  readonly graph?: unknown;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
}

export function advanceWorkflow(
  input: AdvanceWorkflowInput,
): WorkflowTransitionPlan {
  return advanceWorkflowFromSchedulerState({
    checkpoint: parseCheckpoint(input.checkpoint),
    ...(input.graph === undefined
      ? {}
      : { schedulerState: parseSchedulerGraph(input.graph) }),
    ...(input.observations === undefined
      ? {}
      : { observations: input.observations }),
    occurredAt: input.occurredAt,
    maximumAdmissions: input.maximumAdmissions,
  });
}

export { deriveReadyNodes, parseSchedulerGraph };
export type { SchedulerGraph, WorkflowObservation };
export type { ReadyNodeDecision } from './graph-scheduler.js';
export * from './index.js';
