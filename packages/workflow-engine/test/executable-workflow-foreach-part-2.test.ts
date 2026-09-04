import { describe, expect, it } from 'vitest';

import {
  productionEngine,
  testingEngine,
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
  executeNodeAttempt,
  invocationKey,
  createHash,
  nodeRelease,
  forEachGraph,
  nestedForEachGraph,
} from './executable-workflow.fixtures.js';

describe('For Each production operations', () => {
  it('advances a nested For Each through inner and outer completion', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: nestedForEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true }),
      ),
    });
    const base = {
      runId: 'run-nested-foreach',
      executable,
      workflowVersionId: 'version-1',
      occurredAt: '2026-08-24T11:00:00.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    } as const;
    const initial = await advanceWorkflow({
      ...base,
      checkpoint: createCheckpointV2({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 3,
      }),
      observations: [],
    });
    const manual = initial.attempts.find(({ nodeId }) => nodeId === 'manual');
    if (manual === undefined) throw new Error('manual attempt missing');
    const afterManual = await advanceWorkflow({
      ...base,
      checkpoint: initial.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: initial.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: manual.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000220',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000220',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: initial.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000220',
          invocationKey: manual.invocationKey,
          value: {},
        },
      ],
    });
    const outerControl = afterManual.attempts.find(
      ({ nodeId }) => nodeId === 'loop',
    );
    if (outerControl === undefined) throw new Error('outer control missing');
    const outerDeclared = await advanceWorkflow({
      ...base,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: outerControl.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000221',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000221',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000221',
          invocationKey: outerControl.invocationKey,
          value: { items: [['inner']], iterationCount: 1 },
        },
      ],
    });
    const innerControl = outerDeclared.attempts.find(
      ({ nodeId }) => nodeId === 'body-first',
    );
    if (innerControl === undefined) throw new Error('inner control missing');
    const innerDeclared = await advanceWorkflow({
      ...base,
      checkpoint: outerDeclared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: outerDeclared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: innerControl.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000222',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000222',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: outerDeclared.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000222',
          invocationKey: innerControl.invocationKey,
          value: { items: ['inner'], iterationCount: 1 },
        },
      ],
    });
    const nestedBody = innerDeclared.attempts.find(
      ({ nodeId }) => nodeId === 'nested-body',
    );
    if (nestedBody === undefined) throw new Error('nested body missing');
    const innerCompleted = await advanceWorkflow({
      ...base,
      checkpoint: innerDeclared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: innerDeclared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: nestedBody.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000223',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000223',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: innerDeclared.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000223',
          invocationKey: nestedBody.invocationKey,
          value: { nested: true },
        },
      ],
    });
    expect(innerCompleted.checkpoint.loops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          loopId: 'body-first',
          activeOrdinals: [],
          terminalOrdinals: [0],
        }),
      ]),
    );
    const outerSinkReady = await advanceWorkflow({
      ...base,
      checkpoint: innerCompleted.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    const outerSink = outerSinkReady.attempts.find(
      ({ nodeId }) => nodeId === 'body-sink',
    );
    if (outerSink === undefined) throw new Error('outer sink missing');
    const completed = await advanceWorkflow({
      ...base,
      checkpoint: outerSinkReady.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: outerSinkReady.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: outerSink.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000224',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000224',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: outerSinkReady.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000224',
          invocationKey: outerSink.invocationKey,
          value: { outer: true },
        },
      ],
    });
    expect(completed.checkpoint.loops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          loopId: 'loop',
          activeOrdinals: [],
          terminalOrdinals: [0],
        }),
        expect.objectContaining({
          loopId: 'body-first',
          activeOrdinals: [],
          terminalOrdinals: [0],
        }),
      ]),
    );
    expect(
      completed.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === outerControl.invocationKey,
      ),
    ).toMatchObject({ status: 'succeeded' });
  });

  it('executes structured input and exact scoped upstream output at the attempt seam', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true }),
      ),
    });
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 1 }] as const;
    const collection = [{ name: 'first' }, { name: 'nearest' }] as const;
    const declaredCollectionChecksum = createHash('sha256')
      .update(JSON.stringify(collection))
      .digest('hex');
    let received: unknown;
    await executeNodeAttempt({
      runId: 'run-foreach',
      nodeRunId: 'node-run-body',
      attemptId: 'attempt-body',
      executable,
      workflowVersionId: 'version-1',
      invocationKey: invocationKey({
        workflowVersionId: 'version-1',
        nodeId: 'body-sink',
        iterationPath,
      }),
      nodeId: 'body-sink',
      iterationPath,
      structuredCollection: {
        loopNodeId: 'loop',
        ordinal: 1,
        collection,
        collectionSize: 2,
        declaredCollectionChecksum,
      },
      runInput: { name: 'outer' },
      completedNodeOutputs: [
        {
          invocationKey: invocationKey({
            workflowVersionId: 'version-1',
            nodeId: 'body-first',
            iterationPath,
          }),
          nodeId: 'body-first',
          value: { from: 'same-iteration' },
        },
      ],
      registry: {
        execute: (request) => {
          received = request.input;
          return Promise.resolve({
            kind: 'succeeded',
            output: request.input as never,
          });
        },
      },
      signal: new AbortController().signal,
    });
    expect(received).toEqual({ value: { from: 'same-iteration' } });

    await expect(
      executeNodeAttempt({
        runId: 'run-foreach',
        nodeRunId: 'node-run-root',
        attemptId: 'attempt-root',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'body-first',
          iterationPath,
        }),
        nodeId: 'body-first',
        iterationPath,
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: 1,
          collection,
          collectionSize: 2,
          declaredCollectionChecksum,
        },
        runInput: { name: 'outer' },
        completedNodeOutputs: [],
        registry: {
          execute: (request) => {
            received = request.input;
            return Promise.resolve({
              kind: 'succeeded',
              output: request.input as never,
            });
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(received).toEqual({ value: { name: 'nearest' } });

    await expect(
      executeNodeAttempt({
        runId: 'run-foreach',
        nodeRunId: 'node-run-tampered',
        attemptId: 'attempt-tampered',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'body-first',
          iterationPath,
        }),
        nodeId: 'body-first',
        iterationPath,
        structuredCollection: {
          loopNodeId: 'loop',
          ordinal: 1,
          collection: [{ name: 'first' }, { name: 'forged' }],
          collectionSize: 2,
          declaredCollectionChecksum,
        },
        runInput: { name: 'outer' },
        completedNodeOutputs: [],
        registry: {
          execute: () => Promise.resolve({ kind: 'succeeded', output: {} }),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });

    const nestedExecutable = buildWorkflowExecutableV2({
      graph: nestedForEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true }),
      ),
    });
    const nestedIterationPath = [
      { loopNodeId: 'loop', ordinal: 0 },
      { loopNodeId: 'body-first', ordinal: 1 },
    ] as const;
    const nestedCollection = ['inner-first', 'inner-nearest'] as const;
    await expect(
      executeNodeAttempt({
        runId: 'run-nested',
        nodeRunId: 'node-run-nested',
        attemptId: 'attempt-nested',
        executable: nestedExecutable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'nested-body',
          iterationPath: nestedIterationPath,
        }),
        nodeId: 'nested-body',
        iterationPath: nestedIterationPath,
        structuredCollection: {
          loopNodeId: 'body-first',
          ordinal: 1,
          collection: nestedCollection,
          collectionSize: 2,
          declaredCollectionChecksum: createHash('sha256')
            .update(JSON.stringify(nestedCollection))
            .digest('hex'),
        },
        runInput: { value: 'outer-run-input' },
        completedNodeOutputs: [],
        registry: {
          execute: (request) =>
            Promise.resolve({
              kind: 'succeeded',
              output: request.input as never,
            }),
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      output: { value: 'inner-nearest' },
    });
  });

  it('keeps the generic scheduler graph seam on the server-only testing entry', () => {
    for (const internalName of [
      'assertAttemptTransition',
      'assertNodeTransition',
      'assertRunTransition',
      'createLoopState',
      'decideCancellation',
      'decideRetry',
      'deriveReadyNodes',
      'parseSchedulerGraph',
      'planDurableWait',
      'settleJoin',
    ]) {
      expect(productionEngine).not.toHaveProperty(internalName);
      expect(testingEngine).toHaveProperty(internalName);
    }
    expect(testingEngine).toHaveProperty('deriveReadyNodes');
    expect(testingEngine.advanceWorkflow).not.toBe(
      productionEngine.advanceWorkflow,
    );
  });
});
