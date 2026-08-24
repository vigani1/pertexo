import { describe, expect, it } from 'vitest';

import { parsePersistedPhase3Checkpoint } from '../src/phase3-checkpoint.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000101';
const conditionKey = `${workflowVersionId}|condition|b:|i:`;
const selectedKey = `${workflowVersionId}|selected|b:condition%3Atrue|i:`;
const loopKey = `${workflowVersionId}|loop|b:condition%3Atrue|i:`;
const bodyKey = `${workflowVersionId}|body|b:condition%3Atrue|i:loop%3A0`;

function checkpointV1() {
  return {
    schemaVersion: 1,
    engineVersion: 'engine-v1',
    workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 1_000,
    cancelRequested: false,
    deadlineExpired: false,
  } as const;
}

describe('persisted coordinator checkpoint codec', () => {
  it('canonicalizes Condition checkpoint V2 without reinterpreting V1', () => {
    const retained = checkpointV1();
    expect(parsePersistedPhase3Checkpoint(retained)).toEqual(retained);

    expect(
      parsePersistedPhase3Checkpoint({
        ...retained,
        schemaVersion: 2,
        revision: 2,
        runStatus: 'running',
        readySet: [selectedKey],
        admittedInvocationKeys: [conditionKey, selectedKey],
        invocations: [
          {
            invocationKey: selectedKey,
            nodeId: 'selected',
            status: 'ready',
            attemptNumber: 0,
            branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
          },
          {
            invocationKey: conditionKey,
            nodeId: 'condition',
            status: 'succeeded',
            attemptNumber: 1,
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000201',
            },
          },
        ],
        branchSelections: [
          {
            invocationKey: conditionKey,
            nodeId: 'condition',
            selectedOutputPort: 'true',
          },
          {
            invocationKey: conditionKey,
            nodeId: 'condition',
            selectedOutputPort: 'true',
          },
        ],
      }),
    ).toMatchObject({
      schemaVersion: 2,
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
      invocations: [
        {
          invocationKey: selectedKey,
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
        { invocationKey: conditionKey },
      ],
    });
  });

  it('rejects conflicting or non-succeeded Condition selections', () => {
    const base = {
      ...checkpointV1(),
      schemaVersion: 2,
      invocations: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000201',
          },
        },
      ],
    } as const;
    const selection = {
      invocationKey: conditionKey,
      nodeId: 'condition',
      selectedOutputPort: 'true',
    } as const;

    expect(() =>
      parsePersistedPhase3Checkpoint({
        ...base,
        branchSelections: [
          selection,
          { ...selection, selectedOutputPort: 'false' },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ name: 'Phase3CheckpointInvalidError' }),
    );
    expect(() =>
      parsePersistedPhase3Checkpoint({
        ...base,
        invocations: [{ ...base.invocations[0], status: 'running' }],
        branchSelections: [selection],
      }),
    ).toThrow(
      expect.objectContaining({ name: 'Phase3CheckpointInvalidError' }),
    );
  });

  it('accepts a bounded settled Merge ledger in checkpoint V2', () => {
    expect(
      parsePersistedPhase3Checkpoint({
        ...checkpointV1(),
        schemaVersion: 2,
        branchSelections: [],
        invocations: [
          {
            invocationKey: `${workflowVersionId}|merge|b:|i:`,
            nodeId: 'merge',
            status: 'succeeded',
            attemptNumber: 0,
            branchPath: [],
            iterationPath: [],
          },
        ],
        joins: [
          {
            joinInvocationKey: `${workflowVersionId}|merge|b:|i:`,
            joinId: 'merge',
            branchPath: [],
            iterationPath: [],
            policy: { kind: 'all' },
            ledger: [
              {
                branchId: 'branch-01',
                disposition: 'arrived',
                output: {
                  kind: 'inline',
                  attemptId: '00000000-0000-4000-8000-000000000202',
                },
              },
              { branchId: 'branch-02', disposition: 'skipped' },
            ],
            selectedBranchIds: ['branch-01'],
          },
        ],
      }),
    ).toMatchObject({
      joins: [
        {
          joinId: 'merge',
          selectedBranchIds: ['branch-01'],
        },
      ],
    });
  });

  it('accepts exact scoped For Each state and preserves loop-free V2', () => {
    const loop = parsePersistedPhase3Checkpoint({
      ...checkpointV1(),
      schemaVersion: 2,
      runStatus: 'waiting',
      remainingIterationBudget: 998,
      initialIterationBudget: 1_000,
      branchSelections: [],
      admittedInvocationKeys: [loopKey, bodyKey],
      readySet: [bodyKey],
      invocations: [
        {
          invocationKey: loopKey,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000203',
          },
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
          iterationPath: [],
        },
        {
          invocationKey: bodyKey,
          nodeId: 'body',
          status: 'ready',
          attemptNumber: 0,
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        },
      ],
      loops: [
        {
          controlInvocationKey: loopKey,
          loopId: 'loop',
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
          iterationPath: [],
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'body',
          collection: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000203',
          },
          collectionChecksum: 'a'.repeat(64),
          collectionSize: 2,
          maxConcurrency: 1,
          maxIterations: 2,
          nextOrdinal: 1,
          activeOrdinals: [0],
          terminalOrdinals: [],
        },
      ],
    });

    expect(loop).toMatchObject({
      schemaVersion: 2,
      initialIterationBudget: 1_000,
      loops: [{ controlInvocationKey: loopKey, activeOrdinals: [0] }],
      invocations: [{ iterationPath: [] }, { iterationPath: [{ ordinal: 0 }] }],
    });
    expect(
      parsePersistedPhase3Checkpoint({
        ...checkpointV1(),
        schemaVersion: 2,
        branchSelections: [],
      }),
    ).not.toHaveProperty('initialIterationBudget');
  });

  it('rejects tampered loop scope, topology, ordinal, and budget state', () => {
    const base = {
      ...checkpointV1(),
      schemaVersion: 2,
      initialIterationBudget: 1_000,
      branchSelections: [],
      invocations: [
        {
          invocationKey: `${workflowVersionId}|loop|b:|i:`,
          nodeId: 'loop',
          status: 'waiting',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000204',
          },
          branchPath: [],
          iterationPath: [],
        },
      ],
      loops: [
        {
          controlInvocationKey: `${workflowVersionId}|loop|b:|i:`,
          loopId: 'loop',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'sink',
          collection: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000204',
          },
          collectionChecksum: 'b'.repeat(64),
          collectionSize: 1,
          maxConcurrency: 1,
          maxIterations: 1,
          nextOrdinal: 0,
          activeOrdinals: [],
          terminalOrdinals: [],
        },
      ],
      remainingIterationBudget: 999,
    } as const;

    for (const invalid of [
      { ...base, remainingIterationBudget: 1_000 },
      {
        ...base,
        loops: [{ ...base.loops[0], controlInvocationKey: 'tampered' }],
      },
      { ...base, loops: [{ ...base.loops[0], nextOrdinal: 1 }] },
      {
        ...base,
        loops: [{ ...base.loops[0], bodyRootNodeIds: [] }],
      },
    ])
      expect(() => parsePersistedPhase3Checkpoint(invalid)).toThrow(
        expect.objectContaining({ name: 'Phase3CheckpointInvalidError' }),
      );
  });
});
