import type { OutputReference } from '../workflow-execution.js';

export const AGENT_LIMITS = Object.freeze({
  turns: 5,
  toolCalls: 4,
  modelDispatches: 8,
  inputTokens: 128_000,
  outputTokens: 8_192,
  costNanoDollars: 250_000_000,
  timeoutMillis: 120_000,
});

type AttemptReceipt = Extract<OutputReference, { kind: 'inline' }>;

export interface AgentContinuation {
  readonly parentInvocationKey: string;
  readonly deadlineAt: string;
  /** Rates in nano-dollars per token, frozen before the first model turn. */
  readonly modelRates: Readonly<{ input: number; output: number }>;
  readonly budget: Readonly<{
    dispatches: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;
  readonly turn: number;
  readonly phase: AgentPhase;
}

type AgentPhase =
  | Readonly<{ kind: 'model_turn' }>
  | Readonly<{
      kind: 'proposed_call';
      ordinal: number;
      proposal: AttemptReceipt;
    }>
  | Readonly<{
      kind: 'approval_wait';
      ordinal: number;
      proposal: AttemptReceipt;
      task: Extract<OutputReference, { kind: 'task' }>;
    }>
  | Readonly<{
      kind: 'running_tool';
      ordinal: number;
      proposal: AttemptReceipt;
    }>
  | Readonly<{ kind: 'completion'; output: AttemptReceipt }>;
