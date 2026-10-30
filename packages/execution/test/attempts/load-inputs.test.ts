import { createHash } from 'node:crypto';

import {
  NodeAttemptStateCorruptError,
  type NodeAttemptLease,
  type NodeAttemptStoredInputs,
} from '@pertexo/database/attempts';
import { createCheckpoint, invocationKey } from '@pertexo/workflow-engine';
import { canonicalJson } from '@pertexo/workflow-model';
import { describe, expect, it, vi } from 'vitest';

import { loadAttemptInputs } from '../../src/attempts/load-inputs.js';

const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const DECLARING_ATTEMPT = '44444444-4444-4444-8444-444444444444';
const items = ['a', 'b', 'c'];
const loopKey = invocationKey({
  workflowVersionId: VERSION_ID,
  nodeId: 'loop',
});
const bodyScope = [{ loopNodeId: 'loop', ordinal: 1 }] as const;

function lease(overrides: Partial<NodeAttemptLease> = {}): NodeAttemptLease {
  return {
    workflowVersionId: VERSION_ID,
    invocationKey: invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'body',
    }),
    nodeId: 'body',
    ...overrides,
  } as NodeAttemptLease;
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    ...createCheckpoint({
      workflowVersionId: VERSION_ID,
      iterationBudget: 10,
      nextEventSequence: 2,
    }),
    ...overrides,
  };
}

function storeWith(
  stored: Partial<NodeAttemptStoredInputs>,
  declaration?: unknown,
) {
  return {
    loadInputs: vi.fn().mockResolvedValue({
      control: { kind: 'none' },
      completedNodeOutputs: [],
      runInput: null,
      checkpoint: checkpoint(),
      ...stored,
    }),
    readAttemptOutputs: vi.fn().mockResolvedValue([]),
    readLoopDeclaration: vi.fn().mockResolvedValue(declaration),
    listNodeOutcomes: vi.fn().mockResolvedValue([]),
    readNodeOutputs: vi.fn().mockResolvedValue([]),
  };
}

const request = (selected: NodeAttemptLease) => ({
  lease: selected,
  upstreamNodeOutputs: [],
  signal: new AbortController().signal,
});

function loopCheckpoint() {
  return checkpoint({
    remainingIterationBudget: 7,
    invocations: [
      {
        invocationKey: loopKey,
        nodeId: 'loop',
        status: 'waiting',
        attemptNumber: 1,
      },
    ],
    loops: [
      {
        controlInvocationKey: loopKey,
        loopId: 'loop',
        branchPath: [],
        iterationPath: [],
        bodyRootNodeIds: ['body'],
        bodySinkNodeId: 'body',
        collection: { kind: 'inline', attemptId: DECLARING_ATTEMPT },
        collectionChecksum: createHash('sha256')
          .update(canonicalJson(items))
          .digest('hex'),
        collectionSize: items.length,
        maxConcurrency: 1,
        maxIterations: 10,
        nextOrdinal: 2,
        activeOrdinals: [1],
        completedPrefix: 0,
        terminalOrdinals: [0],
      },
    ],
  });
}

describe('loop results', () => {
  const after = lease({ nodeId: 'after' });
  const sinkKey = (
    ordinal: number,
    branchPath: string[] = [],
    enclosing: { loopNodeId: string; ordinal: number }[] = [],
  ) =>
    invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'shape',
      branchPath,
      iterationPath: [...enclosing, { loopNodeId: 'loop', ordinal }],
    });
  const loopOutput = {
    nodeId: 'loop',
    invocationKey: loopKey,
    value: { items, iterationCount: 3 },
  };
  const loops = {
    loops: [{ nodeId: 'loop', invocationKey: loopKey, sinkNodeId: 'shape' }],
    maxBytes: 1_000,
  };

  it('passes on each pass’s result in item order, null for a skipped pass', async () => {
    const store = storeWith({ completedNodeOutputs: [loopOutput] });
    store.listNodeOutcomes.mockResolvedValue([
      { invocationKey: sinkKey(2), status: 'succeeded', outputBytes: 20 },
      {
        invocationKey: sinkKey(1, ['check:true']),
        status: 'skipped',
        outputBytes: 0,
      },
      { invocationKey: sinkKey(0), status: 'succeeded', outputBytes: 20 },
      // The same step in another loop instance is not this loop's pass.
      {
        invocationKey: sinkKey(0, [], [{ loopNodeId: 'outer', ordinal: 1 }]),
        status: 'succeeded',
        outputBytes: 900,
      },
    ]);
    store.readNodeOutputs.mockResolvedValue([
      { invocationKey: sinkKey(0), output: { name: 'A' } },
      { invocationKey: sinkKey(2), output: { name: 'C' } },
    ]);
    const loaded = await loadAttemptInputs(store, request(after), loops);
    expect(loaded.completedNodeOutputs).toEqual([
      {
        ...loopOutput,
        value: {
          items,
          iterationCount: 3,
          results: [{ name: 'A' }, null, { name: 'C' }],
        },
      },
    ]);
    expect(loaded.loopResultsTooLarge).toBeUndefined();
    expect(store.listNodeOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'shape' }),
    );
  });

  it('reads the passes of a loop nested in another loop’s pass', async () => {
    const enclosing = [{ loopNodeId: 'outer', ordinal: 1 }];
    const outerKey = invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'outer',
    });
    const outerItems = ['first', 'second'];
    const store = storeWith(
      {
        completedNodeOutputs: [
          { ...loopOutput, value: { items: ['x'], iterationCount: 1 } },
        ],
        checkpoint: checkpoint({
          remainingIterationBudget: 8,
          invocations: [
            {
              invocationKey: outerKey,
              nodeId: 'outer',
              status: 'waiting',
              attemptNumber: 1,
            },
          ],
          loops: [
            {
              controlInvocationKey: outerKey,
              loopId: 'outer',
              branchPath: [],
              iterationPath: [],
              bodyRootNodeIds: ['loop'],
              bodySinkNodeId: 'after',
              collection: { kind: 'inline', attemptId: DECLARING_ATTEMPT },
              collectionChecksum: createHash('sha256')
                .update(canonicalJson(outerItems))
                .digest('hex'),
              collectionSize: outerItems.length,
              maxConcurrency: 1,
              maxIterations: 10,
              nextOrdinal: 2,
              activeOrdinals: [1],
              completedPrefix: 1,
              terminalOrdinals: [],
            },
          ],
        }),
      },
      {
        nodeId: 'outer',
        attemptId: DECLARING_ATTEMPT,
        output: { items: outerItems, iterationCount: 2 },
      },
    );
    store.listNodeOutcomes.mockResolvedValue([
      {
        invocationKey: sinkKey(0, [], [{ loopNodeId: 'outer', ordinal: 0 }]),
        status: 'succeeded',
        outputBytes: 10,
      },
      {
        invocationKey: sinkKey(0, [], enclosing),
        status: 'succeeded',
        outputBytes: 10,
      },
    ]);
    store.readNodeOutputs.mockResolvedValue([
      { invocationKey: sinkKey(0, [], enclosing), output: 'inner-1' },
    ]);
    const loaded = await loadAttemptInputs(
      store,
      request(lease({ nodeId: 'after', iterationPath: enclosing })),
      loops,
    );
    expect(loaded.completedNodeOutputs[0]?.value).toMatchObject({
      results: ['inner-1'],
    });
  });

  it('flags results too large to pass on without reading them', async () => {
    const store = storeWith({ completedNodeOutputs: [loopOutput] });
    store.listNodeOutcomes.mockResolvedValue(
      [0, 1, 2].map((ordinal) => ({
        invocationKey: sinkKey(ordinal),
        status: 'succeeded',
        outputBytes: 400,
      })),
    );
    const loaded = await loadAttemptInputs(store, request(after), loops);
    expect(loaded.loopResultsTooLarge).toBe(true);
    expect(store.readNodeOutputs).not.toHaveBeenCalled();
  });

  it('leaves other upstream outputs alone', async () => {
    const other = { nodeId: 'set', invocationKey: 'set-key', value: { a: 1 } };
    const store = storeWith({ completedNodeOutputs: [other] });
    await expect(
      loadAttemptInputs(store, request(after), loops),
    ).resolves.toMatchObject({ completedNodeOutputs: [other] });
    expect(store.listNodeOutcomes).not.toHaveBeenCalled();
  });
});

describe('loadAttemptInputs', () => {
  it('passes stored values through without a checkpoint projection', async () => {
    const store = storeWith({ runInput: { order: 7 } });
    await expect(loadAttemptInputs(store, request(lease()))).resolves.toEqual({
      control: { kind: 'none' },
      completedNodeOutputs: [],
      runInput: { order: 7 },
    });
    expect(store.readLoopDeclaration).not.toHaveBeenCalled();
  });

  it('projects a join selection with each selected branch’s result as the coordinator input', async () => {
    const joinKey = invocationKey({
      workflowVersionId: VERSION_ID,
      nodeId: 'join',
    });
    const store = storeWith({
      checkpoint: checkpoint({
        invocations: [
          {
            invocationKey: joinKey,
            nodeId: 'join',
            status: 'running',
            attemptNumber: 1,
          },
        ],
        joins: [
          {
            joinInvocationKey: joinKey,
            joinId: 'join',
            policy: { kind: 'any' },
            ledger: [
              {
                branchId: 'left',
                disposition: 'arrived',
                output: { kind: 'inline', attemptId: DECLARING_ATTEMPT },
              },
              { branchId: 'right', disposition: 'skipped' },
            ],
            selectedBranchIds: ['left'],
          },
        ],
      }),
    });

    store.readAttemptOutputs.mockResolvedValue([
      { attemptId: DECLARING_ATTEMPT, output: { total: 3 } },
    ]);
    const joinLease = lease({ invocationKey: joinKey, nodeId: 'join' });
    const inputs = await loadAttemptInputs(store, request(joinLease));
    expect(store.readAttemptOutputs).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: joinLease,
        attemptIds: [DECLARING_ATTEMPT],
      }),
    );
    expect(inputs.coordinatorInput).toEqual({
      ledger: {
        left: { disposition: 'arrived', output: { total: 3 } },
        right: { disposition: 'skipped' },
      },
      selectedBranchIds: ['left'],
    });

    store.readAttemptOutputs.mockResolvedValue([]);
    await expect(loadAttemptInputs(store, request(joinLease))).rejects.toThrow(
      NodeAttemptStateCorruptError,
    );
  });

  it('projects the For Each item for the attempt ordinal', async () => {
    const store = storeWith(
      { checkpoint: loopCheckpoint() },
      {
        nodeId: 'loop',
        attemptId: DECLARING_ATTEMPT,
        output: { items, iterationCount: items.length },
      },
    );

    const inputs = await loadAttemptInputs(
      store,
      request(lease({ iterationPath: bodyScope })),
    );
    expect(inputs.structuredCollection).toEqual({
      loopNodeId: 'loop',
      ordinal: 1,
      collection: items,
      collectionSize: 3,
      declaredCollectionChecksum: expect.any(String) as unknown,
    });
    expect(store.readLoopDeclaration).toHaveBeenCalledWith(
      expect.objectContaining({ controlInvocationKey: loopKey }),
    );
  });

  it('fails closed when the loop declaration is missing', async () => {
    const store = storeWith({ checkpoint: loopCheckpoint() }, undefined);
    await expect(
      loadAttemptInputs(store, request(lease({ iterationPath: bodyScope }))),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
  });
});

it('refuses oversized or duplicate upstream sets before reading stored inputs', async () => {
  const store = storeWith({});
  for (const upstreamNodeOutputs of [
    Array.from({ length: 101 }, (_, index) => ({
      nodeId: `n${String(index)}`,
      invocationKey: `k${String(index)}`,
    })),
    [
      { nodeId: 'a', invocationKey: 'same' },
      { nodeId: 'b', invocationKey: 'same' },
    ],
  ]) {
    await expect(
      loadAttemptInputs(store, {
        lease: lease(),
        signal: new AbortController().signal,
        upstreamNodeOutputs,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
  }
  expect(store.loadInputs).not.toHaveBeenCalled();
});
