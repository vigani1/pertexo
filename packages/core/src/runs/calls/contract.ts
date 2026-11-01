import type { InitialCheckpointFactory } from '../commands/initial-checkpoint.js';
import type { RunAdvanceInput } from '../advance/contract.js';

export interface WorkflowCallStore {
  /** Executes durable run actions before the normal parent advance transaction. */
  performActions(
    input: RunAdvanceInput,
    prepareChild: InitialCheckpointFactory,
  ): Promise<void>;
  close(): Promise<void>;
}

export type WorkflowCallRefusalCode =
  | 'call_target_unavailable'
  | 'call_target_not_callable'
  | 'call_target_capacity_exceeded'
  | 'call_input_invalid'
  | 'call_deadline_expired';
