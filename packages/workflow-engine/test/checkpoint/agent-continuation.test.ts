import { describe, expect, it } from 'vitest';
import { resumeAgent } from '../../src/control-nodes/resume-agent.js';
import { createCheckpoint, parseCheckpoint } from '../../src/server.js';

const version = '00000000-0000-4000-8000-000000000001';
const parent = `${version}|agent|b:|i:`;
const proposal = {
  kind: 'inline',
  attemptId: '00000000-0000-4000-8000-000000000002',
};
const output = {
  kind: 'inline',
  attemptId: '00000000-0000-4000-8000-000000000003',
};

function replacementCoordinator(phase: unknown) {
  const saved = JSON.stringify(retainedCheckpoint(phase));
  const checkpoint = parseCheckpoint(JSON.parse(saved) as unknown);
  const agent = checkpoint.agents?.at(0);
  if (agent === undefined) throw new Error('Expected a retained Agent');
  return resumeAgent(checkpoint.workflowVersionId, agent);
}

function retainedCheckpoint(phase: unknown) {
  return {
    ...createCheckpoint({ workflowVersionId: version, iterationBudget: 0 }),
    runStatus: 'running',
    invocations: [
      {
        nodeId: 'agent',
        invocationKey: parent,
        status: 'pending',
        attemptNumber: 0,
      },
    ],
    agents: [
      {
        parentInvocationKey: parent,
        deadlineAt: '2026-11-22T00:01:00.000Z',
        modelRates: { input: 10, output: 20 },
        budget: {
          dispatches: 1,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCost: 2_000,
        },
        turn: 1,
        phase,
      },
    ],
  };
}

describe('retained Agent checkpoints', () => {
  it('keeps the committed proposal when the coordinator is replaced', () => {
    const phase = { kind: 'proposed_call', ordinal: 1, proposal };
    const admission = replacementCoordinator(phase);
    expect(admission).toMatchObject({ kind: 'admit_tool', proposal });
    if (admission.kind !== 'admit_tool')
      throw new Error('Expected tool admission');
    expect(replacementCoordinator({ ...phase, kind: 'running_tool' })).toEqual({
      kind: 'observe_tool',
      invocationKey: admission.invocationKey,
    });
    expect(replacementCoordinator({ kind: 'model_turn' })).not.toHaveProperty(
      'invocationKey',
      admission.invocationKey,
    );
  });

  it('keeps the committed completion reference through a restart', () => {
    const phase = { kind: 'completion', output };
    expect(replacementCoordinator(phase)).toEqual(phase);
  });

  it('refuses a proposal phase with no completion receipt reference', () => {
    expect(() =>
      parseCheckpoint(
        retainedCheckpoint({
          kind: 'proposed_call',
          ordinal: 1,
          proposal: { kind: 'task', taskId: proposal.attemptId },
        }),
      ),
    ).toThrow('Agent proposal must reference an attempt receipt');
  });
});
