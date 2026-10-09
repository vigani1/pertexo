import { expect, it } from 'vitest';
import { platformServingRegistryRelease } from '@pertexo/node-catalog';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
} from '@pertexo/workflow-engine';
import { curatedScheduleInputCase } from './curated-template-worker-evidence.js';

it('the actual reviewed For Each fails its pinned bound before any body admission', async () => {
  const descriptor = CURATED_WORKFLOW_TEMPLATES[1];
  if (descriptor === undefined) throw new Error('Reviewed schedule missing');
  const items = ['a', 'b', 'c', 'd'].map((value) => ({ value }));
  const graph = {
    ...descriptor.manifest.graph,
    nodes: descriptor.manifest.graph.nodes.map((node) =>
      node.id === 'batch-items'
        ? {
            ...node,
            inputMappings: {
              ...node.inputMappings,
              items: { kind: 'literal' as const, value: items },
            },
          }
        : node,
    ),
  };
  const executable = buildWorkflowExecutableV2({
    graph,
    release: composeExecutableCompatibilityRelease(
      platformServingRegistryRelease(),
    ),
  });
  const version = '00000000-0000-4000-8000-000000000001';
  const base = {
    executable,
    workflowVersionId: version,
    runId: 'owned-loop-bound',
    occurredAt: '2026-10-02T00:00:00.000Z',
    maximumAdmissions: 1,
    signal: new AbortController().signal,
  } as const;
  let result = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpointV2({
      engineVersion: 'engine-v1',
      workflowVersionId: version,
      iterationBudget: 10,
    }),
    observations: [],
  });
  for (const [ordinal, value] of [
    curatedScheduleInputCase,
    { items, iterationCount: items.length },
  ].entries()) {
    const attempt = result.attempts[0];
    if (attempt === undefined) throw new Error('Reviewed attempt missing');
    const checkpoint = result.checkpoint;
    const attemptId = `00000000-0000-4000-8000-00000000010${String(ordinal)}`;
    result = await advanceWorkflow({
      ...base,
      checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: attempt.invocationKey,
          attemptId,
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: checkpoint.nextEventSequence,
          attemptId,
          invocationKey: attempt.invocationKey,
          value,
        },
      ],
    });
  }
  expect(result.checkpoint.runStatus).toBe('failed');
  expect(result.checkpoint.loops).toEqual([]);
  expect(
    result.checkpoint.invocations.find((node) => node.nodeId === 'batch-items'),
  ).toMatchObject({ status: 'failed', attemptNumber: 1 });
  expect(result.events).toContainEqual(
    expect.objectContaining({
      name: 'node.failed',
      nodeId: 'batch-items',
      reasonCode: 'loop_limit_exceeded',
    }),
  );
  expect(result.attempts).toEqual([]);
  expect(result.nodeRunAdmissions).toEqual([]);
});
