import { AGENT_LIMITS, type AgentContinuation } from './agent-continuation.js';
import { AGENT_TOOL_LIMITS } from '@pertexo/workflow-model';

type ModelBudget = AgentContinuation['budget'];
type ModelRates = AgentContinuation['modelRates'];
type TokenCounts = Readonly<{ inputTokens: number; outputTokens: number }>;

export type ModelReservation = TokenCounts &
  Readonly<{ estimatedCost: number }>;

// Reserve one input token per encoded request byte and the full output grant.
export const agentTurnTokenEnvelope = Object.freeze({
  inputTokens: AGENT_TOOL_LIMITS.requestBytes,
  outputTokens: AGENT_TOOL_LIMITS.outputTokens,
});

export function settleAgentTurnUsage(
  continuation: AgentContinuation,
  reported: TokenCounts | undefined,
) {
  return settleAgentInference(
    continuation,
    {
      ...agentTurnTokenEnvelope,
      estimatedCost: estimatedCost(
        agentTurnTokenEnvelope,
        continuation.modelRates,
      ),
    },
    reported,
  );
}

type BudgetRefusal = Readonly<{
  kind: 'refused';
  reason:
    | 'agent.deadline'
    | 'agent.dispatch_limit'
    | 'agent.token_limit'
    | 'agent.cost_limit'
    | 'agent.accounting';
}>;

export function reserveAgentInference(
  continuation: AgentContinuation,
  request: TokenCounts,
  occurredAt: string,
):
  | Readonly<{
      kind: 'reserved';
      budget: ModelBudget;
      reservation: ModelReservation;
    }>
  | BudgetRefusal {
  if (Date.parse(occurredAt) >= Date.parse(continuation.deadlineAt))
    return { kind: 'refused', reason: 'agent.deadline' };
  if (!validTokenCounts(request) || request.outputTokens === 0)
    return { kind: 'refused', reason: 'agent.accounting' };

  const current = continuation.budget;
  if (current.dispatches >= AGENT_LIMITS.modelDispatches)
    return { kind: 'refused', reason: 'agent.dispatch_limit' };

  const inputTokens = current.inputTokens + request.inputTokens;
  const outputTokens = current.outputTokens + request.outputTokens;
  if (
    inputTokens > AGENT_LIMITS.inputTokens ||
    outputTokens > AGENT_LIMITS.outputTokens
  )
    return { kind: 'refused', reason: 'agent.token_limit' };

  const reservation = {
    ...request,
    estimatedCost: estimatedCost(request, continuation.modelRates),
  };
  const totalCost = current.estimatedCost + reservation.estimatedCost;
  if (totalCost > AGENT_LIMITS.costNanoDollars)
    return { kind: 'refused', reason: 'agent.cost_limit' };

  return {
    kind: 'reserved',
    reservation,
    budget: {
      dispatches: current.dispatches + 1,
      inputTokens,
      outputTokens,
      estimatedCost: totalCost,
    },
  };
}

export function settleAgentInference(
  continuation: AgentContinuation,
  reservation: ModelReservation,
  reported: TokenCounts | undefined,
): Readonly<{ kind: 'settled'; budget: ModelBudget }> | BudgetRefusal {
  if (reported === undefined)
    return { kind: 'settled', budget: continuation.budget };
  if (
    !validTokenCounts(reported) ||
    reported.inputTokens > reservation.inputTokens ||
    reported.outputTokens > reservation.outputTokens
  )
    return { kind: 'refused', reason: 'agent.accounting' };

  const current = continuation.budget;
  return {
    kind: 'settled',
    budget: {
      dispatches: current.dispatches,
      inputTokens:
        current.inputTokens - reservation.inputTokens + reported.inputTokens,
      outputTokens:
        current.outputTokens - reservation.outputTokens + reported.outputTokens,
      estimatedCost:
        current.estimatedCost -
        reservation.estimatedCost +
        estimatedCost(reported, continuation.modelRates),
    },
  };
}

function estimatedCost(counts: TokenCounts, rates: ModelRates): number {
  return counts.inputTokens * rates.input + counts.outputTokens * rates.output;
}

function validTokenCounts({ inputTokens, outputTokens }: TokenCounts): boolean {
  return (
    Number.isSafeInteger(inputTokens) &&
    Number.isSafeInteger(outputTokens) &&
    inputTokens >= 0 &&
    outputTokens >= 0
  );
}
