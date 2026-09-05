import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
  invocationKey,
  nodeRelease,
  forEachGraph,
} from './executable-workflow.fixtures.js';

describe('For Each production operations', () => {
  it('schedules a For Each structured body by stable scoped ordinals', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: forEachGraph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true, setRetryClass: 'idempotent-with-key' }),
      ),
    });
    const base = {
      runId: 'run-foreach',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-08-24T10:00:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    } as const;
    const initial = await advanceWorkflow({
      ...base,
      checkpoint: createCheckpointV2({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 2,
      }),
      observations: [],
    });
    const manual = initial.attempts[0];
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
          attemptId: '00000000-0000-4000-8000-000000000101',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: initial.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000101',
          invocationKey: manual.invocationKey,
          value: {},
        },
      ],
    });
    const control = afterManual.attempts[0];
    if (control === undefined) throw new Error('For Each control missing');
    const declared = await advanceWorkflow({
      ...base,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000102',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000102',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000102',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000102',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(declared.checkpoint.remainingIterationBudget).toBe(0);
    expect(
      declared.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({
      status: 'waiting',
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000102',
      },
    });
    expect(declared.attempts).toEqual([
      expect.objectContaining({
        nodeId: 'body-first',
        iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
      }),
    ]);
    expect(typeof declared.attempts[0]?.providerIdempotencyKey).toBe('string');
    expect(declared.checkpoint.loops[0]).toMatchObject({
      controlInvocationKey: control.invocationKey,
      activeOrdinals: [0],
      nextOrdinal: 1,
      terminalOrdinals: [],
    });
    const replayedDeclaration = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000102',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000102',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000102',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(replayedDeclaration.checkpoint.remainingIterationBudget).toBe(0);
    expect(replayedDeclaration.checkpoint.loops).toEqual(
      declared.checkpoint.loops,
    );
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: afterManual.checkpoint,
        observations: [
          {
            kind: 'outcome',
            sequence: afterManual.checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: control.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000102',
            attemptNumber: 1,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000102',
            },
          },
        ],
        completedOutputs: [
          {
            sequence: afterManual.checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000102',
            invocationKey: control.invocationKey,
            value: { items: ['first', 'second'], iterationCount: 2 },
          },
          {
            sequence: afterManual.checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000102',
            invocationKey: control.invocationKey,
            value: { items: ['changed'], iterationCount: 1 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });

    const firstRoot = declared.attempts[0];
    if (firstRoot === undefined) throw new Error('first body root missing');
    const afterRoot = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000104',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000104',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: declared.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000104',
          invocationKey: firstRoot.invocationKey,
          value: { value: 'first' },
        },
      ],
    });
    expect(afterRoot.attempts).toEqual([
      expect.objectContaining({
        nodeId: 'body-sink',
        iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
      }),
    ]);
    const firstSink = afterRoot.attempts[0];
    if (firstSink === undefined) throw new Error('first body sink missing');
    const nextOrdinal = await advanceWorkflow({
      ...base,
      checkpoint: afterRoot.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterRoot.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstSink.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000105',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000105',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterRoot.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000105',
          invocationKey: firstSink.invocationKey,
          value: { value: 'first' },
        },
      ],
    });
    expect(nextOrdinal.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [1],
      nextOrdinal: 2,
      terminalOrdinals: [0],
    });
    expect(nextOrdinal.attempts).toEqual([
      expect.objectContaining({
        nodeId: 'body-first',
        iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
      }),
    ]);

    const retryingBody = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000110',
          attemptNumber: 1,
          failureKind: 'retry',
          errorKind: 'network',
          possiblyDispatched: false,
          safeErrorCode: 'body.retry',
        },
      ],
      completedOutputs: [],
    });
    expect(
      retryingBody.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === firstRoot.invocationKey,
      ),
    ).toMatchObject({ status: 'waiting', attemptNumber: 1 });
    expect(retryingBody.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [],
    });

    const finalBodyFailure = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000111',
          attemptNumber: 1,
          failureKind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'body.failed',
        },
      ],
      completedOutputs: [],
    });
    expect(finalBodyFailure.attempts).toEqual([]);
    expect(finalBodyFailure.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 1,
      terminalStatus: 'failed',
    });
    expect(
      finalBodyFailure.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({ status: 'failed' });

    const failedBody = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000107',
          attemptNumber: 1,
          status: 'failed',
          reasonCode: 'body_failed',
        },
      ],
      completedOutputs: [],
    });
    expect(failedBody.attempts).toEqual([]);
    expect(failedBody.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 1,
      terminalStatus: 'failed',
    });
    expect(
      failedBody.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({
      status: 'failed',
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000102',
      },
    });

    const limitedCheckpoint = structuredClone(afterManual.checkpoint);
    Object.assign(limitedCheckpoint, {
      initialIterationBudget: 1,
      remainingIterationBudget: 1,
    });
    const limited = await advanceWorkflow({
      ...base,
      checkpoint: limitedCheckpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: limitedCheckpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000103',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000103',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: limitedCheckpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000103',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(limited.checkpoint.remainingIterationBudget).toBe(1);
    expect(limited.checkpoint.loops).toEqual([]);
    expect(limited.attempts).toEqual([]);
    expect(limited.events).toContainEqual(
      expect.objectContaining({
        name: 'node.failed',
        nodeId: 'loop',
        reasonCode: 'loop_limit_exceeded',
      }),
    );

    const empty = await advanceWorkflow({
      ...base,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000106',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000106',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000106',
          invocationKey: control.invocationKey,
          value: { items: [], iterationCount: 0 },
        },
      ],
    });
    expect(empty.attempts).toEqual([]);
    expect(
      empty.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({
      status: 'succeeded',
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000106',
      },
    });

    const artifactDeclaration = await advanceWorkflow({
      ...base,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000108',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'artifact',
            artifactId: '00000000-0000-4000-8000-000000000109',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000108',
          invocationKey: control.invocationKey,
          value: { items: [], iterationCount: 0 },
        },
      ],
    });
    expect(artifactDeclaration.checkpoint.loops[0]?.collection).toEqual({
      kind: 'artifact',
      artifactId: '00000000-0000-4000-8000-000000000109',
    });

    const refunded = structuredClone(declared.checkpoint);
    Object.assign(refunded, { remainingIterationBudget: 1 });
    await expect(
      advanceWorkflow({ ...base, checkpoint: refunded, observations: [] }),
    ).rejects.toMatchObject({ code: 'checkpoint_invalid' });

    const tamperedTopology = structuredClone(declared.checkpoint);
    Object.assign(tamperedTopology.loops[0] ?? {}, {
      bodySinkNodeId: 'body-first',
    });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: tamperedTopology,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    const tamperedBounds = structuredClone(declared.checkpoint);
    Object.assign(tamperedBounds.loops[0] ?? {}, { maxConcurrency: 2 });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: tamperedBounds,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const bodyOutsideLoop = structuredClone(declared.checkpoint);
    const unscopedBody = bodyOutsideLoop.invocations.find(
      ({ invocationKey: key }) => key === firstRoot.invocationKey,
    );
    if (unscopedBody === undefined) throw new Error('body root missing');
    const unscopedBodyKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: unscopedBody.nodeId,
    });
    Object.assign(unscopedBody, { invocationKey: unscopedBodyKey });
    Reflect.deleteProperty(unscopedBody, 'branchPath');
    Reflect.deleteProperty(unscopedBody, 'iterationPath');
    Object.assign(bodyOutsideLoop, {
      admittedInvocationKeys: bodyOutsideLoop.admittedInvocationKeys.map(
        (key) => (key === firstRoot.invocationKey ? unscopedBodyKey : key),
      ),
    });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: bodyOutsideLoop,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const wrongOrdinal = structuredClone(declared.checkpoint);
    const wrongOrdinalBody = wrongOrdinal.invocations.find(
      ({ invocationKey: key }) => key === firstRoot.invocationKey,
    );
    if (wrongOrdinalBody === undefined) throw new Error('body root missing');
    const undeclaredIterationPath = [{ loopNodeId: 'loop', ordinal: 1 }];
    const wrongOrdinalKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: wrongOrdinalBody.nodeId,
      iterationPath: undeclaredIterationPath,
    });
    Object.assign(wrongOrdinalBody, {
      invocationKey: wrongOrdinalKey,
      iterationPath: undeclaredIterationPath,
    });
    Object.assign(wrongOrdinal, {
      admittedInvocationKeys: wrongOrdinal.admittedInvocationKeys.map((key) =>
        key === firstRoot.invocationKey ? wrongOrdinalKey : key,
      ),
    });
    await expect(
      advanceWorkflow({ ...base, checkpoint: wrongOrdinal, observations: [] }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const scopedTopLevel = structuredClone(declared.checkpoint);
    const scopedControl = scopedTopLevel.invocations.find(
      ({ invocationKey: key }) => key === control.invocationKey,
    );
    if (scopedControl === undefined) throw new Error('control missing');
    const scopedControlKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: scopedControl.nodeId,
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    });
    Object.assign(scopedControl, {
      invocationKey: scopedControlKey,
      iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
    });
    Object.assign(scopedTopLevel.loops[0] ?? {}, {
      controlInvocationKey: scopedControlKey,
    });
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: scopedTopLevel,
        observations: [],
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });

    const skippedGraph = structuredClone(forEachGraph());
    const skippedControl = skippedGraph.nodes.find(({ id }) => id === 'loop');
    if (skippedControl === undefined || !('structured' in skippedControl))
      throw new Error('For Each structure missing');
    for (const bodyNode of skippedControl.structured.body.nodes)
      Object.assign(bodyNode, { disabled: true });
    const skippedExecutable = buildWorkflowExecutableV2({
      graph: skippedGraph,
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true, setRetryClass: 'idempotent-with-key' }),
      ),
    });
    const skippedDeclaration = await advanceWorkflow({
      ...base,
      executable: skippedExecutable,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000112',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000112',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000112',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(skippedDeclaration.attempts).toEqual([]);
    const skippedSink = await advanceWorkflow({
      ...base,
      executable: skippedExecutable,
      checkpoint: skippedDeclaration.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(skippedSink.attempts).toEqual([]);
    const skippedSettled = await advanceWorkflow({
      ...base,
      executable: skippedExecutable,
      checkpoint: skippedSink.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(skippedSettled.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [1],
      terminalOrdinals: [0],
    });

    const canceledBetweenBatches = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
        },
      ],
      completedOutputs: [],
    });
    expect(canceledBetweenBatches.attempts).toEqual([]);
    expect(canceledBetweenBatches.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 1,
      activeOrdinals: [],
      terminalOrdinals: [0],
      terminalStatus: 'canceled',
    });
    expect(canceledBetweenBatches.checkpoint.cancelRequested).toBe(true);
    expect(canceledBetweenBatches.checkpoint.runStatus).toBe('canceled');
    const replayedCancellation = await advanceWorkflow({
      ...base,
      checkpoint: canceledBetweenBatches.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(replayedCancellation.checkpoint.loops).toEqual(
      canceledBetweenBatches.checkpoint.loops,
    );
    expect(replayedCancellation.attempts).toEqual([]);

    const expiredActiveLoop = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
      ],
      completedOutputs: [],
    });
    expect(expiredActiveLoop.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      terminalOrdinals: [0],
      terminalStatus: 'timed_out',
    });
    expect(expiredActiveLoop.checkpoint.runStatus).toBe('timed_out');
    expect(
      expiredActiveLoop.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({ status: 'timed_out' });
    const replayedDeadline = await advanceWorkflow({
      ...base,
      checkpoint: expiredActiveLoop.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(replayedDeadline.checkpoint.loops).toEqual(
      expiredActiveLoop.checkpoint.loops,
    );
    expect(replayedDeadline.attempts).toEqual([]);
    expect(
      expiredActiveLoop.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === firstRoot.invocationKey,
      ),
    ).toMatchObject({ status: 'timed_out' });

    const canceledDeadline = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
        {
          kind: 'cancel_requested',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: '2026-08-24T10:00:30.000Z',
        },
      ],
      completedOutputs: [],
    });
    expect(canceledDeadline.checkpoint.loops[0]).toMatchObject({
      terminalStatus: 'canceled',
      terminalOrdinals: [0],
    });
    expect(canceledDeadline.checkpoint.runStatus).toBe('canceled');

    const concurrentGraph = structuredClone(forEachGraph());
    const concurrentControl = concurrentGraph.nodes.find(
      ({ id }) => id === 'loop',
    );
    if (concurrentControl === undefined || !('structured' in concurrentControl))
      throw new Error('For Each structure missing');
    Object.assign(concurrentControl.structured, { maxConcurrency: 2 });
    const concurrentExecutable = buildWorkflowExecutableV2({
      graph: concurrentGraph,
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true, setRetryClass: 'idempotent-with-key' }),
      ),
    });
    const concurrent = await advanceWorkflow({
      ...base,
      executable: concurrentExecutable,
      checkpoint: afterManual.checkpoint,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000113',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000113',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000113',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(concurrent.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0, 1],
      nextOrdinal: 2,
    });
    expect(
      concurrent.attempts.map(({ iterationPath }) => iterationPath),
    ).toEqual([
      [{ loopNodeId: 'loop', ordinal: 0 }],
      [{ loopNodeId: 'loop', ordinal: 1 }],
    ]);
    const concurrentRoots = new Map(
      concurrent.attempts.map((attempt) => [
        attempt.iterationPath?.at(-1)?.ordinal,
        attempt,
      ]),
    );
    const firstConcurrentFailure = await advanceWorkflow({
      ...base,
      executable: concurrentExecutable,
      checkpoint: concurrent.checkpoint,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: concurrentRoots.get(1)?.invocationKey ?? '',
          attemptId: '00000000-0000-4000-8000-000000000118',
          attemptNumber: 1,
          failureKind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'body.first-failure',
        },
      ],
      completedOutputs: [],
    });
    expect(firstConcurrentFailure.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [1],
      terminalStatus: 'failed',
    });
    const secondConcurrentFailure = await advanceWorkflow({
      ...base,
      executable: concurrentExecutable,
      checkpoint: firstConcurrentFailure.checkpoint,
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: concurrentRoots.get(0)?.invocationKey ?? '',
          attemptId: '00000000-0000-4000-8000-000000000119',
          attemptNumber: 1,
          failureKind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'body.later-failure',
        },
      ],
      completedOutputs: [],
    });
    expect(secondConcurrentFailure.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      terminalOrdinals: [0, 1],
      terminalStatus: 'failed',
    });
    expect(
      secondConcurrentFailure.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({ status: 'failed' });
    const completeConcurrent = async (order: readonly number[]) => {
      const roots = new Map(
        concurrent.attempts.map((attempt) => [
          attempt.iterationPath?.at(-1)?.ordinal,
          attempt,
        ]),
      );
      const rootObservations = order.map((ordinal, index) => {
        const attempt = roots.get(ordinal);
        if (attempt === undefined) throw new Error('concurrent root missing');
        const attemptId = `00000000-0000-4000-8000-000000000${ordinal === 0 ? '114' : '115'}`;
        return {
          kind: 'outcome' as const,
          sequence: concurrent.checkpoint.nextEventSequence + index,
          occurredAt: base.occurredAt,
          invocationKey: attempt.invocationKey,
          attemptId,
          attemptNumber: 1,
          status: 'succeeded' as const,
          output: { kind: 'inline' as const, attemptId },
        };
      });
      const rootsCompleted = await advanceWorkflow({
        ...base,
        executable: concurrentExecutable,
        checkpoint: concurrent.checkpoint,
        maximumAdmissions: 10,
        observations: rootObservations,
        completedOutputs: rootObservations.map((observation) => ({
          sequence: observation.sequence,
          attemptId: observation.attemptId,
          invocationKey: observation.invocationKey,
          value: {},
        })),
      });
      const sinks = new Map(
        rootsCompleted.attempts.map((attempt) => [
          attempt.iterationPath?.at(-1)?.ordinal,
          attempt,
        ]),
      );
      const sinkObservations = order.map((ordinal, index) => {
        const attempt = sinks.get(ordinal);
        if (attempt === undefined) throw new Error('concurrent sink missing');
        const attemptId = `00000000-0000-4000-8000-000000000${ordinal === 0 ? '116' : '117'}`;
        return {
          kind: 'outcome' as const,
          sequence: rootsCompleted.checkpoint.nextEventSequence + index,
          occurredAt: base.occurredAt,
          invocationKey: attempt.invocationKey,
          attemptId,
          attemptNumber: 1,
          status: 'succeeded' as const,
          output: { kind: 'inline' as const, attemptId },
        };
      });
      return advanceWorkflow({
        ...base,
        executable: concurrentExecutable,
        checkpoint: rootsCompleted.checkpoint,
        maximumAdmissions: 10,
        observations: sinkObservations,
        completedOutputs: sinkObservations.map((observation) => ({
          sequence: observation.sequence,
          attemptId: observation.attemptId,
          invocationKey: observation.invocationKey,
          value: {},
        })),
      });
    };
    const forwardCompletion = await completeConcurrent([0, 1]);
    const reverseCompletion = await completeConcurrent([1, 0]);
    expect(reverseCompletion.checkpoint.loops).toEqual(
      forwardCompletion.checkpoint.loops,
    );
    expect(reverseCompletion.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      terminalOrdinals: [0, 1],
    });
  });
});
