import { createHash } from 'node:crypto';

import {
  NodeAttemptStateCorruptError,
  type NodeAttemptLease,
  type NodeAttemptStoredInputs,
} from '@pertexo/database/attempts';
import { createCheckpointV2, invocationKey } from '@pertexo/workflow-engine';
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
    ...createCheckpointV2({
      engineVersion: 'phase3-engine-v1',
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
      abortRequested: false,
      completedNodeOutputs: [],
      runInput: null,
      checkpoint: checkpoint(),
      ...stored,
    }),
    readLoopDeclaration: vi.fn().mockResolvedValue(declaration),
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
        terminalOrdinals: [0],
      },
    ],
  });
}

describe('loadAttemptInputs', () => {
  it('passes stored values through without a checkpoint projection', async () => {
    const store = storeWith({ runInput: { order: 7 } });
    await expect(loadAttemptInputs(store, request(lease()))).resolves.toEqual({
      abortRequested: false,
      completedNodeOutputs: [],
      runInput: { order: 7 },
    });
    expect(store.readLoopDeclaration).not.toHaveBeenCalled();
  });

  it('rejects an upstream output outside the attempt scope before reading', async () => {
    const store = storeWith({});
    await expect(
      loadAttemptInputs(store, {
        ...request(lease()),
        upstreamNodeOutputs: [
          { nodeId: 'other', invocationKey: 'not-a-scoped-key' },
        ],
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    expect(store.loadInputs).not.toHaveBeenCalled();
  });

  it('projects a join selection as the coordinator input', async () => {
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

    const inputs = await loadAttemptInputs(
      store,
      request(lease({ invocationKey: joinKey, nodeId: 'join' })),
    );
    expect(inputs.coordinatorInput).toEqual({
      ledger: {
        left: {
          disposition: 'arrived',
          output: { kind: 'inline', attemptId: DECLARING_ATTEMPT },
        },
        right: { disposition: 'skipped' },
      },
      selectedBranchIds: ['left'],
    });
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

  it.each([
    ['a missing declaration', undefined],
    [
      'a changed collection',
      {
        nodeId: 'loop',
        attemptId: DECLARING_ATTEMPT,
        output: { items: ['x', 'y', 'z'], iterationCount: 3 },
      },
    ],
    [
      'another attempt',
      {
        nodeId: 'loop',
        attemptId: '55555555-5555-4555-8555-555555555555',
        output: { items, iterationCount: 3 },
      },
    ],
  ])('fails closed for %s', async (_name, declaration) => {
    const store = storeWith({ checkpoint: loopCheckpoint() }, declaration);
    await expect(
      loadAttemptInputs(store, request(lease({ iterationPath: bodyScope }))),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
  });
});
