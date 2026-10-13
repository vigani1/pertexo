import { describe, expect, it } from 'vitest';
import {
  createCheckpoint,
  invocationKey,
  parseCheckpoint,
} from '../../src/index.js';

const versionId = '00000000-0000-4000-8000-000000000001';
const nodeRunId = '00000000-0000-4000-8000-000000000002';

function seed() {
  return {
    ...createCheckpoint({
      workflowVersionId: versionId,
      iterationBudget: 1_000,
    }),
    invocations: [
      {
        invocationKey: invocationKey({
          workflowVersionId: versionId,
          nodeId: 'saved',
        }),
        nodeId: 'saved',
        status: 'succeeded',
        attemptNumber: 0,
        output: { kind: 'reused', nodeRunId },
      },
    ],
  };
}

describe('reused checkpoint values', () => {
  it('retains the owned node value without inventing a successful attempt', () => {
    const restored = parseCheckpoint(JSON.parse(JSON.stringify(seed())));
    expect(restored.invocations[0]).toMatchObject({
      status: 'succeeded',
      attemptNumber: 0,
      output: { kind: 'reused', nodeRunId },
    });
    expect(restored.readySet).toEqual([]);
    expect(restored.admittedInvocationKeys).toEqual([]);
  });

  it.each([
    { status: 'failed' },
    { status: 'ready' },
    { attemptNumber: 1 },
    { output: { kind: 'reused', nodeRunId: 'not-a-node-id' } },
    { output: { kind: 'reused', nodeRunId, attemptId: nodeRunId } },
  ])('refuses incompatible reused execution state: %j', (change) => {
    const value = seed();
    expect(() =>
      parseCheckpoint({
        ...value,
        invocations: [{ ...value.invocations[0], ...change }],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
});
