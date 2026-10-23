import { describe, expect, it } from 'vitest';
import {
  createCheckpoint,
  invocationKey,
  parseCheckpoint,
  reconstructReadySet,
} from '../../../src/index.js';
import { checkpoint, occurredAt } from '../../support/advance-workflow.js';

import { advanceWorkflow } from '../../support/checkpoint/seam.js';

describe('checkpoint seam', () => {
  it('defaults the additive retained deadline flag to false', () => {
    const { deadlineExpired: _, ...retained } = checkpoint();
    expect(parseCheckpoint(retained).deadlineExpired).toBe(false);
    expect(checkpoint().deadlineExpired).toBe(false);
  });
  it('rejects malformed present optional scope fields', () => {
    const base = checkpoint();
    const controlKey = invocationKey({
      workflowVersionId: base.workflowVersionId,
      nodeId: 'legacy-loop',
    });
    const retained = {
      ...base,
      invocations: [
        {
          invocationKey: controlKey,
          nodeId: 'legacy-loop',
          status: 'succeeded',
          attemptNumber: 1,
        },
      ],
      loops: [
        {
          loopId: 'legacy-loop',
          collection: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000202',
          },
          collectionChecksum: 'legacy-checksum',
          collectionSize: 0,
          maxConcurrency: 1,
          maxIterations: 1,
          nextOrdinal: 0,
          activeOrdinals: [],
          terminalOrdinals: [],
          branchPath: null,
        },
      ],
    };

    expect(() => parseCheckpoint(retained)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(() =>
      parseCheckpoint({
        ...retained,
        loops: [
          {
            ...retained.loops[0],
            branchPath: [],
            controlInvocationKey: 42,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...base,
        joins: [
          {
            joinId: 'join',
            joinInvocationKey: 42,
            policy: { kind: 'all' },
            ledger: [{ branchId: 'branch', disposition: 'pending' }],
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint({
        ...retained,
        loops: [
          {
            ...retained.loops[0],
            branchPath: [],
            bodyRootNodeIds: 'legacy-loop',
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
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
