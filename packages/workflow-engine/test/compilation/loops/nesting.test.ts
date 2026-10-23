import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  nestedForEachGraph,
} from '../../support/executable-workflow.js';
import { structuredAttemptFixture } from '../../support/compilation/structured-attempt.js';

describe('For Each production operations', () => {
  it('advances a nested For Each through inner and outer completion', async () => {
    const executable = buildWorkflowExecutable({
      graph: nestedForEachGraph(),
      catalog: composeExecutableCatalog(nodeCatalog({ forEach: true })),
    });
    const base = {
      runId: 'run-nested-foreach',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-08-24T11:00:00.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    } as const;
    const initial = await advanceWorkflow({
      ...base,
      checkpoint: createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
          completedPrefix: 1,
          terminalOrdinals: [],
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
    expect(completed.checkpoint.loops).toEqual([
      expect.objectContaining({
        loopId: 'loop',
        activeOrdinals: [],
        completedPrefix: 1,
        terminalOrdinals: [],
      }),
    ]);
    expect(completed.checkpoint.retiredIterationBudget).toBe(1);
    expect(
      completed.checkpoint.invocations.every(
        ({ iterationPath }) => (iterationPath?.length ?? 0) === 0,
      ),
    ).toBe(true);
    expect(
      completed.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === outerControl.invocationKey,
      ),
    ).toMatchObject({ status: 'succeeded' });
    // A stop can arrive between loop settlement and successor admission.
    // Completed loop truth must survive that extra coordinator delivery.
    for (const kind of ['cancel_requested', 'deadline_expired'] as const) {
      const stopped = await advanceWorkflow({
        ...base,
        checkpoint: completed.checkpoint,
        observations: [
          {
            kind,
            ...(kind === 'cancel_requested'
              ? { sequence: completed.checkpoint.nextEventSequence }
              : {}),
            occurredAt: base.occurredAt,
          },
        ],
        completedOutputs: [],
      });
      expect(stopped.attempts).toEqual([]);
      expect(stopped.checkpoint.runStatus).toBe(
        kind === 'cancel_requested' ? 'canceled' : 'timed_out',
      );
      expect(stopped.checkpoint.loops).toEqual(completed.checkpoint.loops);
      expect(stopped.checkpoint.invocations).toEqual(
        completed.checkpoint.invocations,
      );
    }
  });
  it('resolves exact same-iteration upstream output', async () => {
    const {
      collection,
      declaredCollectionChecksum,
      executable,
      iterationPath,
    } = structuredAttemptFixture();
    let received: unknown;
    await executeNodeAttempt({
      runId: 'run-foreach',
      nodeRunId: 'node-run-body',
      attemptId: 'attempt-body',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      invocationKey: invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
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
  });
});
