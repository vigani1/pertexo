import type { OutputReference } from '../workflow-execution.js';

export type AgentModelRates = Readonly<{ input: number; output: number }>;

export type AgentAttemptReceipt = Extract<OutputReference, { kind: 'inline' }>;

export interface AgentContinuation {
  readonly parentInvocationKey: string;
  readonly deadlineAt: string;
  /** Rates in nano-dollars per token, frozen before the first model turn. */
  readonly modelRates: AgentModelRates;
  readonly budget: Readonly<{
    dispatches: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;
  readonly turn: number;
  readonly history?: readonly Readonly<{
    proposal: AgentAttemptReceipt;
    output: AgentAttemptReceipt;
  }>[];
  readonly phase: AgentPhase;
}

type AgentPhase =
  | Readonly<{ kind: 'model_turn' }>
  | Readonly<{
      kind: 'proposed_call';
      ordinal: number;
      proposal: AgentAttemptReceipt;
    }>
  | Readonly<{
      kind: 'approval_wait';
      ordinal: number;
      proposal: AgentAttemptReceipt;
      task: Extract<OutputReference, { kind: 'task' }>;
    }>
  | Readonly<{
      kind: 'running_tool';
      ordinal: number;
      proposal: AgentAttemptReceipt;
    }>
  | Readonly<{ kind: 'completion'; output: AgentAttemptReceipt }>;
