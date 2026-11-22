import { AGENT_LIMITS } from '@pertexo/workflow-model';
import type { AgentToolCall } from '@pertexo/workflow-model';
import type {
  AgentContinuation,
  AgentAttemptReceipt,
  AgentToolExchange,
} from './agent-continuation.js';

type AgentWorkRefusal = Readonly<{
  kind: 'refused';
  reason:
    | 'agent.tool_unavailable'
    | 'agent.tool_limit'
    | 'agent.turn_limit'
    | 'agent.stale_receipt';
}>;
type AgentWorkDecision =
  Readonly<{ kind: 'continue'; agent: AgentContinuation }> | AgentWorkRefusal;
type ModelTurnReceipt = Readonly<{ output: AgentAttemptReceipt }> &
  (
    | Readonly<{ kind: 'final' }>
    | Readonly<{ kind: 'proposal'; call: AgentToolCall }>
  );

export function settleAgentModelTurn(
  agent: AgentContinuation,
  receipt: ModelTurnReceipt,
  toolAlias: string,
): AgentWorkDecision {
  if (agent.phase.kind !== 'model_turn')
    return { kind: 'refused', reason: 'agent.stale_receipt' };
  if (receipt.kind === 'final') {
    if (hasConsumedReceipt(agent, receipt.output))
      return { kind: 'refused', reason: 'agent.stale_receipt' };
    return {
      kind: 'continue',
      agent: {
        ...agent,
        phase: { kind: 'completion', output: receipt.output },
      },
    };
  }
  if (receipt.call.name !== toolAlias)
    return { kind: 'refused', reason: 'agent.tool_unavailable' };
  const ordinal = (agent.history?.length ?? 0) + 1;
  if (ordinal > AGENT_LIMITS.toolCalls)
    return { kind: 'refused', reason: 'agent.tool_limit' };
  if (agent.turn >= AGENT_LIMITS.turns)
    return { kind: 'refused', reason: 'agent.turn_limit' };
  if (hasConsumedReceipt(agent, receipt.output))
    return { kind: 'refused', reason: 'agent.stale_receipt' };
  return {
    kind: 'continue',
    agent: {
      ...agent,
      phase: { kind: 'proposed_call', ordinal, proposal: receipt.output },
    },
  };
}

export function settleAgentReadTool(
  agent: AgentContinuation,
  output: AgentAttemptReceipt,
): AgentWorkDecision {
  return settleAgentTool(agent, { output });
}

export function settleAgentTool(
  agent: AgentContinuation,
  result:
    | { output: AgentAttemptReceipt }
    | Pick<Extract<AgentToolExchange, { child: unknown }>, 'child'>
    | Pick<
        Extract<AgentToolExchange, { childFailure: unknown }>,
        'childFailure'
      >,
): AgentWorkDecision {
  if (
    agent.phase.kind !== 'running_tool' ||
    ('output' in result &&
      (agent.phase.proposal.attemptId === result.output.attemptId ||
        hasConsumedReceipt(agent, result.output)))
  )
    return { kind: 'refused', reason: 'agent.stale_receipt' };
  if (agent.turn >= AGENT_LIMITS.turns)
    return { kind: 'refused', reason: 'agent.turn_limit' };
  return {
    kind: 'continue',
    agent: {
      ...agent,
      turn: agent.turn + 1,
      history: [
        ...(agent.history ?? []),
        { proposal: agent.phase.proposal, ...result },
      ],
      phase: { kind: 'model_turn' },
    },
  };
}

function hasConsumedReceipt(
  agent: AgentContinuation,
  receipt: AgentAttemptReceipt,
): boolean {
  return (
    agent.history?.some(
      (exchange) =>
        exchange.proposal.attemptId === receipt.attemptId ||
        ('output' in exchange &&
          exchange.output.attemptId === receipt.attemptId),
    ) ?? false
  );
}
