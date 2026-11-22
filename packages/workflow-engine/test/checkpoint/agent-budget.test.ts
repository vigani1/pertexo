import { describe, expect, it } from 'vitest';
import {
  reserveAgentInference,
  settleAgentInference,
} from '../../src/control-nodes/agent-budget.js';
import {
  AGENT_LIMITS,
  type AgentContinuation,
} from '../../src/control-nodes/agent-continuation.js';

const started = '2026-11-22T00:00:00.000Z';
const expired = '2026-11-22T00:02:00.000Z';
const agent: AgentContinuation = {
  parentInvocationKey: 'agent',
  deadlineAt: expired,
  modelRates: { input: 10, output: 20 },
  budget: {
    dispatches: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  },
  turn: 1,
  phase: { kind: 'model_turn' },
};
const request = { inputTokens: 100, outputTokens: 50 };

describe('Agent inference accounting', () => {
  it.each([
    [agent.budget, expired, 'agent.deadline'],
    [
      { ...agent.budget, dispatches: AGENT_LIMITS.modelDispatches },
      started,
      'agent.dispatch_limit',
    ],
    [
      { ...agent.budget, inputTokens: AGENT_LIMITS.inputTokens },
      started,
      'agent.token_limit',
    ],
    [
      { ...agent.budget, outputTokens: AGENT_LIMITS.outputTokens },
      started,
      'agent.token_limit',
    ],
    [
      { ...agent.budget, estimatedCost: AGENT_LIMITS.costNanoDollars },
      started,
      'agent.cost_limit',
    ],
  ] as const)(
    'refuses another dispatch when the remaining budget is exhausted (%s, %s, %s)',
    (budget, occurredAt, reason) => {
      expect(
        reserveAgentInference({ ...agent, budget }, request, occurredAt),
      ).toEqual({
        kind: 'refused',
        reason,
      });
    },
  );

  it('keeps unknown charges and refuses to exceed them after replacement', () => {
    const reserve = reserveAgentInference(
      {
        ...agent,
        budget: {
          ...agent.budget,
          outputTokens: AGENT_LIMITS.outputTokens - request.outputTokens,
        },
      },
      request,
      started,
    );
    if (reserve.kind !== 'reserved') throw new Error('Expected a reservation');
    const replacement = { ...agent, budget: reserve.budget };
    const settle = settleAgentInference(
      replacement,
      reserve.reservation,
      undefined,
    );
    expect(settle).toEqual({ kind: 'settled', budget: reserve.budget });
    if (settle.kind !== 'settled') throw new Error('Expected retained charges');
    expect(
      reserveAgentInference(
        { ...replacement, budget: settle.budget },
        request,
        started,
      ),
    ).toEqual({
      kind: 'refused',
      reason: 'agent.token_limit',
    });
  });

  it('releases only the difference between reserved and reported charges', () => {
    const reserve = reserveAgentInference(agent, request, started);
    if (reserve.kind !== 'reserved') throw new Error('Expected a reservation');
    expect(
      settleAgentInference(
        { ...agent, budget: reserve.budget },
        reserve.reservation,
        {
          inputTokens: 80,
          outputTokens: 12,
        },
      ),
    ).toEqual({
      kind: 'settled',
      budget: {
        dispatches: 1,
        inputTokens: 80,
        outputTokens: 12,
        estimatedCost: 1_040,
      },
    });
  });

  it('refuses to continue if the provider reports more tokens than reserved', () => {
    const reserve = reserveAgentInference(agent, request, started);
    if (reserve.kind !== 'reserved') throw new Error('Expected a reservation');
    expect(
      settleAgentInference(
        { ...agent, budget: reserve.budget },
        reserve.reservation,
        {
          inputTokens: 101,
          outputTokens: 50,
        },
      ),
    ).toEqual({ kind: 'refused', reason: 'agent.accounting' });
  });
});
