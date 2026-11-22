import type { OutputReference } from '../workflow-execution.js';
import { AGENT_TOOL_LIMITS } from '@pertexo/workflow-model';

export const AGENT_LIMITS = Object.freeze({
  turns: 5,
  toolCalls: AGENT_TOOL_LIMITS.historyEntries,
  modelDispatches: 8,
  inputTokens: 128_000,
  outputTokens: 8_192,
  costNanoDollars: 250_000_000,
  timeoutMillis: 120_000,
});

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
