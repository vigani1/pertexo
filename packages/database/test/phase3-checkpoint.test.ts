import { describe, expect, it } from 'vitest';

import { parsePersistedPhase3Checkpoint } from '../src/phase3-checkpoint.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000101';
const conditionKey = `${workflowVersionId}|condition|b:|i:`;
const selectedKey = `${workflowVersionId}|selected|b:condition%3Atrue|i:`;

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
        joins: [
          {
            joinId: 'merge',
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
});
