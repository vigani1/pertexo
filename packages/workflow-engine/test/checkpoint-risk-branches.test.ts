import { describe, expect, it } from 'vitest';

import {
  createCheckpoint,
  createCheckpointV2,
  invocationKey,
  parseCheckpoint,
} from '../src/testing.js';

const workflowVersionId = 'version-1';

function baseV1() {
  return createCheckpoint({
    engineVersion: 'engine-v1',
    workflowVersionId,
    iterationBudget: 100,
  });
}

function rootKey(nodeId: string): string {
  return invocationKey({ workflowVersionId, nodeId });
}

function pendingJoin(join: Record<string, unknown>, status = 'pending') {
  return {
    ...baseV1(),
    invocations: [
      {
        invocationKey: rootKey('join'),
        nodeId: 'join',
        status,
        attemptNumber: 0,
      },
    ],
    joins: [join],
  };
}

function loopCheckpoint(
  loop: Record<string, unknown>,
  status: string,
  flags: { cancelRequested?: boolean; deadlineExpired?: boolean } = {},
) {
  return {
    ...baseV1(),
    ...flags,
    invocations: [
      {
        invocationKey: rootKey('loop'),
        nodeId: 'loop',
        status,
        attemptNumber: 0,
      },
    ],
    loops: [loop],
  };
}

const emptyLoop = {
  loopId: 'loop',
  collection: {
    kind: 'inline',
    attemptId: '00000000-0000-4000-8000-000000000001',
  },
  collectionChecksum: 'checksum',
  collectionSize: 0,
  maxConcurrency: 1,
  maxIterations: 1,
  nextOrdinal: 0,
  activeOrdinals: [],
  terminalOrdinals: [],
};

describe('checkpoint risk branches', () => {
  it.each(['\u001f', '\u007f', '\u07ff', '\u0800', '\ud800', '\udc00', '-0'])(
    'accepts a bounded engine version containing %j',
    (engineVersion) => {
      expect(
        parseCheckpoint({ ...baseV1(), engineVersion }).engineVersion,
      ).toBe(engineVersion);
    },
  );

  it('canonicalizes a negative-zero numeric field', () => {
    expect(
      Object.is(parseCheckpoint({ ...baseV1(), revision: -0 }).revision, -0),
    ).toBe(true);
  });

  it('accepts delayed ready work and rejects wait metadata on terminal work', () => {
    const ready = {
      invocationKey: rootKey('ready'),
      nodeId: 'ready',
      status: 'ready',
      attemptNumber: 1,
      waitKind: 'retry_backoff',
    };
    expect(
      parseCheckpoint({
        ...baseV1(),
        readySet: [ready.invocationKey],
        invocations: [ready],
      }),
    ).toMatchObject({ readySet: [ready.invocationKey] });
    expect(() =>
      parseCheckpoint({
        ...baseV1(),
        invocations: [{ ...ready, status: 'succeeded', waitKind: 'node_wait' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it.each([
    { branchPath: [{ nodeId: 1, outputPort: 'out' }] },
    { branchPath: [{ nodeId: '', outputPort: 'out' }] },
    { branchPath: [{ nodeId: 'branch', outputPort: 1 }] },
    { branchPath: [{ nodeId: 'branch', outputPort: '' }] },
    { iterationPath: [{ loopNodeId: 1, ordinal: 0 }] },
    { iterationPath: [{ loopNodeId: '', ordinal: 0 }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: 0.5 }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: -1 }] },
  ])('rejects malformed V2 invocation scope %#', (scope) => {
    expect(() =>
      parseCheckpoint({
        ...createCheckpointV2({
          engineVersion: 'engine-v2',
          workflowVersionId,
          iterationBudget: 100,
        }),
        invocations: [
          {
            invocationKey: 'invalid-for-malformed-scope',
            nodeId: 'node',
            status: 'pending',
            attemptNumber: 0,
            ...scope,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it.each([
    { branchPath: [{ nodeId: 1, outputPort: 'out' }] },
    { branchPath: [{ nodeId: '', outputPort: 'out' }] },
    { branchPath: [{ nodeId: 'branch', outputPort: 1 }] },
    { branchPath: [{ nodeId: 'branch', outputPort: '' }] },
    { iterationPath: [{ loopNodeId: 1, ordinal: 0 }] },
    { iterationPath: [{ loopNodeId: '', ordinal: 0 }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: 0.5 }] },
    { iterationPath: [{ loopNodeId: 'loop', ordinal: -1 }] },
  ])('rejects malformed join scope %#', (scope) => {
    expect(() =>
      parseCheckpoint(
        pendingJoin({
          joinId: 'join',
          policy: { kind: 'all' },
          ledger: [{ branchId: 'a', disposition: 'pending' }],
          ...scope,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it.each([
    {
      policy: { kind: 'all' },
      ledger: [
        { branchId: 'a', disposition: 'arrived' },
        { branchId: 'b', disposition: 'arrived' },
      ],
      selectedBranchIds: ['a', 'b'],
    },
    {
      policy: { kind: 'any' },
      ledger: [
        { branchId: 'a', disposition: 'arrived' },
        { branchId: 'b', disposition: 'missing' },
      ],
      selectedBranchIds: ['a'],
    },
    {
      policy: { kind: 'count', count: 2 },
      ledger: [
        { branchId: 'a', disposition: 'arrived' },
        { branchId: 'b', disposition: 'arrived' },
      ],
      selectedBranchIds: ['a', 'b'],
    },
  ])('accepts a canonical satisfied join %#', (join) => {
    const checkpoint = pendingJoin({ joinId: 'join', ...join }, 'succeeded');
    expect(parseCheckpoint(checkpoint).joins).toHaveLength(1);
  });

  it.each([
    {
      policy: { kind: 'all' },
      ledger: [{ branchId: 'a', disposition: 'failed' }],
      unsatisfiedReasonCode: 'branch_failed',
    },
    {
      policy: { kind: 'all' },
      ledger: [{ branchId: 'a', disposition: 'canceled' }],
      unsatisfiedReasonCode: 'branch_canceled',
    },
    {
      policy: { kind: 'any' },
      ledger: [{ branchId: 'a', disposition: 'missing' }],
      unsatisfiedReasonCode: 'insufficient_arrivals',
    },
    {
      policy: { kind: 'count', count: 2 },
      ledger: [
        { branchId: 'a', disposition: 'arrived' },
        { branchId: 'b', disposition: 'missing' },
      ],
      unsatisfiedReasonCode: 'insufficient_arrivals',
    },
  ])('accepts a canonical unsatisfied join %#', (join) => {
    const checkpoint = pendingJoin({ joinId: 'join', ...join }, 'failed');
    expect(parseCheckpoint(checkpoint).joins).toHaveLength(1);
  });

  it('rejects persisted join outcomes that contradict the ledger', () => {
    expect(() =>
      parseCheckpoint(
        pendingJoin(
          {
            joinId: 'join',
            policy: { kind: 'any' },
            ledger: [{ branchId: 'a', disposition: 'missing' }],
            selectedBranchIds: [],
          },
          'succeeded',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    expect(() =>
      parseCheckpoint(
        pendingJoin(
          {
            joinId: 'join',
            policy: { kind: 'all' },
            ledger: [{ branchId: 'a', disposition: 'missing' }],
            unsatisfiedReasonCode: 'insufficient_arrivals',
          },
          'failed',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it.each([{ cancelRequested: true }, { deadlineExpired: true }])(
    'accepts a canceled unsettled join under a terminal control %#',
    (flags) => {
      const value = pendingJoin({
        joinId: 'join',
        policy: { kind: 'all' },
        ledger: [{ branchId: 'a', disposition: 'pending' }],
      });
      Object.assign(value, flags);
      value.invocations = [
        {
          invocationKey: rootKey('join'),
          nodeId: 'join',
          status: 'canceled',
          attemptNumber: 0,
        },
      ];
      expect(parseCheckpoint(value).joins).toHaveLength(1);
    },
  );

  it.each([
    [
      { ...emptyLoop, terminalStatus: 'outcome_unknown' },
      'outcome_unknown',
      {},
    ],
    [emptyLoop, 'canceled', { cancelRequested: true }],
    [emptyLoop, 'timed_out', { deadlineExpired: true }],
    [
      { ...emptyLoop, collectionSize: 1 },
      'canceled',
      { cancelRequested: true },
    ],
    [
      { ...emptyLoop, collectionSize: 1 },
      'timed_out',
      { deadlineExpired: true },
    ],
  ] as const)(
    'accepts canonical loop parent state %#',
    (loop, status, flags) => {
      expect(
        parseCheckpoint(loopCheckpoint(loop, status, flags)).loops,
      ).toHaveLength(1);
    },
  );

  it.each([
    { branchPath: [{ nodeId: 1, outputPort: 'out' }] },
    { branchPath: [{ nodeId: '', outputPort: 'out' }] },
    { branchPath: [{ nodeId: 'branch', outputPort: 1 }] },
    { branchPath: [{ nodeId: 'branch', outputPort: '' }] },
  ])('rejects malformed loop branch scope %#', (scope) => {
    expect(() =>
      parseCheckpoint(loopCheckpoint({ ...emptyLoop, ...scope }, 'succeeded')),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('rejects non-object checkpoints', () => {
    expect(() => parseCheckpoint(null)).toThrow(
      expect.objectContaining({ code: 'checkpoint_unsupported' }),
    );
  });

  it('uses node identity to order duplicate invocation keys before rejecting them', () => {
    expect(() =>
      parseCheckpoint({
        ...baseV1(),
        invocations: [
          {
            invocationKey: 'same',
            nodeId: 'z',
            status: 'pending',
            attemptNumber: 0,
          },
          {
            invocationKey: 'same',
            nodeId: 'a',
            status: 'pending',
            attemptNumber: 0,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });

  it('validates both operands of optional next-event sequence input', () => {
    for (const nextEventSequence of [0, 1.5]) {
      expect(() =>
        createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId,
          iterationBudget: 1,
          nextEventSequence,
        }),
      ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    }
  });
});
