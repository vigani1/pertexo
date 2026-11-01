import type { CoordinatorDelivery } from './input.js';
import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import type {
  WorkflowCallOutcome,
  PendingTaskOutcome,
  WorkflowCheckpoint,
} from '@pertexo/workflow-engine';
import type { WorkflowExecutionProjection } from '../queries/execution/contract.js';
import type { JsonValue } from '@pertexo/workflow-model';
import type { RunTransitionPlan } from './plan.js';

export type CoordinatorAdvanceDelivery = Readonly<CoordinatorDelivery>;

/** Everything the engine needs, read under the run lock. */
export type RunAdvanceState = Readonly<{
  runId: string;
  workflowVersionId: string;
  /** Stored checkpoint JSON; the engine parses it. */
  checkpoint: unknown;
  observations: readonly unknown[];
  completedOutputs: readonly unknown[];
  /** A loan explicitly fences new parent node admissions. */
  hasExecutionSlot: boolean;
  callOutcomes: readonly WorkflowCallOutcome[];
  taskOutcomes: readonly PendingTaskOutcome[];
  workflow: WorkflowExecutionProjection;
  /** On-demand completion projection using the already locked run transaction. */
  readCompletionValues(nodeIds?: readonly string[]): Promise<
    Readonly<{
      runInput: JsonValue | undefined;
      variables?: WorkspaceVariableValues;
      outputs: readonly Readonly<{
        nodeId: string;
        invocationKey: string;
        value: JsonValue | undefined;
      }>[];
    }>
  >;
}>;

export type RunAdvanceDecision =
  | Readonly<{ kind: 'no_change' }>
  | Readonly<{
      kind: 'transition';
      /** The stored checkpoint as the engine parsed it. */
      previous: WorkflowCheckpoint;
      plan: RunTransitionPlan;
    }>;

export type RunAdvanceInput = Readonly<{
  delivery: CoordinatorAdvanceDelivery;
  workspaceId: string;
  runId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;

export type RunAdvanceResult =
  | Readonly<{
      kind: 'committed';
      revision: number;
      admittedAttempts: readonly Readonly<{
        invocationKey: string;
        nodeRunId: string;
        attemptId: string;
      }>[];
      scheduleToStartSeconds?: number;
    }>
  | Readonly<{
      kind: 'already_committed' | 'deferred' | 'no_change';
      revision: number;
    }>
  | Readonly<{
      kind: 'not_found' | 'capacity_exceeded';
    }>;

export interface RunAdvanceStore {
  /**
   * Locks the run, reads its state, lets `decide` compute the transition and
   * saves it, all in one transaction.
   */
  advance(
    input: RunAdvanceInput,
    decide: (state: RunAdvanceState) => Promise<RunAdvanceDecision>,
  ): Promise<RunAdvanceResult>;
  close(): Promise<void>;
}
