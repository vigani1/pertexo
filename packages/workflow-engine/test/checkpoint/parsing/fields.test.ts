import { startForEach } from '../../support/compilation/for-each.js';
import { parseJoin } from '../../../src/checkpoint/joins.js';
import { describe, expect, it } from 'vitest';
import {
  createCheckpoint,
  invocationKey,
  parseCheckpoint,
} from '../../../src/server.js';
import { reconstructReadySet } from '../../../src/checkpoint/create-and-parse.js';
import { checkpoint, occurredAt } from '../../support/advance-workflow.js';

import { advanceWorkflow } from '../../support/checkpoint-engine.js';

describe('checkpoint seam', () => {
  it('defaults the additive retained deadline flag to false', () => {
    const { deadlineExpired: _, ...retained } = checkpoint();
    expect(parseCheckpoint(retained).deadlineExpired).toBe(false);
    expect(checkpoint().deadlineExpired).toBe(false);
  });
  it.each([
    {
      field: 'branchPath',
      value: null,
      message: 'loop branch scope must be an array',
    },
    {
      field: 'controlInvocationKey',
      value: 42,
      message: 'loop control key is invalid',
    },
    {
      field: 'bodyRootNodeIds',
      value: 'legacy-loop',
      message: 'loop body roots are invalid',
    },
  ])(
    'rejects malformed retained loop $field for its own reason',
    async ({ field, value, message }) => {
      const { declared } = await startForEach();
      const valid = parseCheckpoint(
        JSON.parse(JSON.stringify(declared.checkpoint)),
      );
      expect(valid).toEqual(declared.checkpoint);
      expect(valid.loops).toHaveLength(1);
      expect(() =>
        parseCheckpoint({
          ...valid,
          loops: valid.loops.map((loop) => ({ ...loop, [field]: value })),
        }),
      ).toThrow(
        expect.objectContaining({ code: 'checkpoint_invalid', message }),
      );
    },
  );
  it('rejects a malformed join invocation key for its own reason', () => {
    const valid = {
      joinId: 'join',
      joinInvocationKey: invocationKey({
        workflowVersionId: checkpoint().workflowVersionId,
        nodeId: 'join',
      }),
      policy: { kind: 'all' },
      ledger: [{ branchId: 'branch', disposition: 'pending' }],
    };
    expect(parseJoin(valid)).toMatchObject(valid);
    expect(() => parseJoin({ ...valid, joinInvocationKey: 42 })).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'join invocation key is invalid',
      }),
    );
  });
  it('requires due time for an ordinary waiting invocation', () => {
    const base = checkpoint();
    expect(() =>
      parseCheckpoint({
        ...base,
        invocations: [
          {
            invocationKey: 'ordinary',
            nodeId: 'ordinary',
            status: 'waiting',
            attemptNumber: 1,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));

    const running = advanceWorkflow({
      checkpoint: base,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        { kind: 'ready', invocationKey: 'ordinary', nodeId: 'ordinary' },
      ],
    });
    const waiting = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'wait',
          waitKind: 'node_wait',
          invocationKey: 'ordinary',
          resumeAt: '2026-08-21T10:00:00.000Z',
        },
      ],
    });
    expect(() =>
      advanceWorkflow({
        checkpoint: waiting.checkpoint,
        occurredAt,
        maximumAdmissions: 0,
        observations: [
          {
            kind: 'outcome',
            invocationKey: 'ordinary',
            status: 'failed',
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'transition_invalid' }));
  });
  it('parses canonical branch selections', () => {
    const base = checkpoint();
    const conditionAKey = invocationKey({
      workflowVersionId: base.workflowVersionId,
      nodeId: 'condition-a',
    });
    const conditionZKey = invocationKey({
      workflowVersionId: base.workflowVersionId,
      nodeId: 'condition-z',
    });
    const parsed = parseCheckpoint({
      ...base,
      invocations: [
        {
          invocationKey: conditionZKey,
          nodeId: 'condition-z',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000102',
          },
        },
        {
          invocationKey: conditionAKey,
          nodeId: 'condition-a',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
      ],
      branchSelections: [
        {
          invocationKey: conditionZKey,
          nodeId: 'condition-z',
          selectedOutputPort: 'false',
        },
        {
          invocationKey: conditionAKey,
          nodeId: 'condition-a',
          selectedOutputPort: 'true',
        },
      ],
    });

    expect(parsed).toMatchObject({
      branchSelections: [
        {
          invocationKey: conditionAKey,
          nodeId: 'condition-a',
          selectedOutputPort: 'true',
        },
        {
          invocationKey: conditionZKey,
          nodeId: 'condition-z',
          selectedOutputPort: 'false',
        },
      ],
    });
    expect(parsed.invocations).not.toContainEqual(
      expect.objectContaining({ branchPath: [] }),
    );
    expect(
      createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000002',
        iterationBudget: 1_000,
      }),
    ).toMatchObject({ branchSelections: [] });
  });
  it('deduplicates identical selections and rejects conflicts or non-success', () => {
    const conditionKey = invocationKey({
      workflowVersionId: checkpoint().workflowVersionId,
      nodeId: 'condition',
    });
    const selection = {
      invocationKey: conditionKey,
      nodeId: 'condition',
      selectedOutputPort: 'true',
    } as const;
    const base = {
      ...checkpoint(),
      invocations: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
      ],
      branchSelections: [selection, selection],
    } as const;

    const parsed = parseCheckpoint(base);
    expect(parsed).toMatchObject({ branchSelections: [selection] });
    expect(() =>
      parseCheckpoint({
        ...base,
        branchSelections: [
          selection,
          { ...selection, selectedOutputPort: 'false' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...base,
        invocations: [{ ...base.invocations[0], status: 'running' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('canonicalizes collections and reconstructs ready work without transport state', () => {
    const parsed = parseCheckpoint({
      ...checkpoint(),
      readySet: ['z', 'a'],
      admittedInvocationKeys: ['z', 'a'],
      invocations: [
        { invocationKey: 'z', nodeId: 'z', status: 'ready', attemptNumber: 0 },
        { invocationKey: 'a', nodeId: 'a', status: 'ready', attemptNumber: 0 },
      ],
    });
    expect(parsed.readySet).toEqual(['a', 'z']);
    expect(
      parsed.invocations.map(({ invocationKey }) => invocationKey),
    ).toEqual(['a', 'z']);
    expect(reconstructReadySet(parsed)).toEqual(['a', 'z']);
  });
});
