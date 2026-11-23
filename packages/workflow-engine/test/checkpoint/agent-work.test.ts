import { AGENT_LIMITS } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import type { AgentContinuation } from '../../src/control-nodes/agent-continuation.js';
import { resumeAgent } from '../../src/control-nodes/resume-agent.js';
import {
  settleAgentModelTurn,
  settleAgentTool,
} from '../../src/control-nodes/settle-agent-work.js';
import {
  agentChildInvocationKey,
  agentToolAliasFromInvocationKey,
  isAgentModelTurnInvocationKey,
} from '../../src/invocations/agent-invocation.js';
import { createCheckpoint, parseCheckpoint } from '../../src/server.js';

const version = '00000000-0000-4000-8000-000000000001';
const modelOutput = {
  kind: 'inline',
  attemptId: '00000000-0000-4000-8000-000000000002',
} as const;
const toolOutput = {
  kind: 'inline',
  attemptId: '00000000-0000-4000-8000-000000000003',
} as const;
const agent: AgentContinuation = {
  parentInvocationKey: `${version}|agent|b:|i:`,
  deadlineAt: '2026-11-22T00:01:00.000Z',
  modelRates: { input: 0, output: 0 },
  budget: {
    dispatches: 1,
    inputTokens: 100,
    outputTokens: 20,
    estimatedCost: 0,
  },
  turn: 1,
  phase: { kind: 'model_turn' },
};
const toolName = 'read_order';
const receipt = {
  kind: 'proposal',
  output: modelOutput,
  call: {
    name: toolName,
    id: 'provider-correlation-id',
    arguments: { order: '123' },
  },
} as const;

describe('Agent receipts', () => {
  it('refuses a model proposal that names a tool outside the pinned setup', () => {
    expect(
      settleAgentModelTurn(
        agent,
        {
          ...receipt,
          call: { ...receipt.call, name: 'write_order' },
        },
        toolName,
      ),
    ).toEqual({ kind: 'refused', reason: 'agent.tool_unavailable' });
  });

  it('refuses another tool call when its result would require a turn beyond the limit', () => {
    expect(
      settleAgentModelTurn(
        { ...agent, turn: AGENT_LIMITS.turns },
        receipt,
        toolName,
      ),
    ).toEqual({
      kind: 'refused',
      reason: 'agent.turn_limit',
    });
  });

  it('refuses another tool call after the tool call budget is spent', () => {
    const history = Array.from({ length: AGENT_LIMITS.toolCalls }, () => ({
      proposal: modelOutput,
      output: toolOutput,
    }));
    expect(
      settleAgentModelTurn({ ...agent, history }, receipt, toolName),
    ).toEqual({
      kind: 'refused',
      reason: 'agent.tool_limit',
    });
  });

  it('refuses a previously consumed proposal during a later model turn', () => {
    const laterTurn: AgentContinuation = {
      ...agent,
      turn: 2,
      history: [{ proposal: modelOutput, output: toolOutput }],
    };
    expect(settleAgentModelTurn(laterTurn, receipt, toolName)).toEqual({
      kind: 'refused',
      reason: 'agent.stale_receipt',
    });
  });

  it('refuses a previously consumed tool receipt during a later tool call', () => {
    const laterCall: AgentContinuation = {
      ...agent,
      turn: 2,
      history: [{ proposal: modelOutput, output: toolOutput }],
      phase: {
        kind: 'running_tool',
        ordinal: 2,
        proposal: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000004',
        },
      },
    };
    expect(settleAgentTool(laterCall, { output: toolOutput })).toEqual({
      kind: 'refused',
      reason: 'agent.stale_receipt',
    });
  });

  it('resumes the next turn with the accepted tool receipt after replacement', () => {
    const accepted = settleAgentModelTurn(agent, receipt, toolName);
    if (
      accepted.kind !== 'continue' ||
      accepted.agent.phase.kind !== 'proposed_call'
    )
      throw new Error('Expected committed proposal');
    const settled = settleAgentTool(
      {
        ...accepted.agent,
        phase: { ...accepted.agent.phase, kind: 'running_tool' },
      },
      { output: toolOutput },
    );
    if (settled.kind !== 'continue') throw new Error('Expected completed tool');
    const stored = {
      ...createCheckpoint({ workflowVersionId: version, iterationBudget: 0 }),
      invocations: [
        {
          invocationKey: agent.parentInvocationKey,
          nodeId: 'agent',
          attemptNumber: 0,
          status: 'pending',
        },
      ],
      agents: [settled.agent],
    };
    const restored = parseCheckpoint(
      JSON.parse(JSON.stringify(stored)) as unknown,
    ).agents?.at(0);
    if (restored === undefined) throw new Error('Expected retained Agent');
    expect(restored.history).toEqual([
      { proposal: modelOutput, output: toolOutput },
    ]);
    const next = resumeAgent(version, restored);
    expect(next.kind).toBe('model_turn');
    expect(next).not.toEqual(resumeAgent(version, agent));
    expect(settleAgentTool(restored, { output: toolOutput })).toEqual({
      kind: 'refused',
      reason: 'agent.stale_receipt',
    });
  });
});

it('keeps a tool aliased model distinct from a model turn', () => {
  const model = agentChildInvocationKey(version, agent.parentInvocationKey, {
    turn: 1,
    work: { kind: 'model_turn' },
  });
  const tool = agentChildInvocationKey(version, agent.parentInvocationKey, {
    turn: 1,
    work: { kind: 'tool_call', ordinal: 1 },
    toolAlias: 'model',
  });
  expect(isAgentModelTurnInvocationKey(model)).toBe(true);
  expect(isAgentModelTurnInvocationKey(tool)).toBe(false);
  expect(agentToolAliasFromInvocationKey(tool)).toBe('model');
});
