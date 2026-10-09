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

it('admits the reviewed schedule successor after an empty For Each declaration', async () => {
  const descriptor = CURATED_WORKFLOW_TEMPLATES[1];
  if (descriptor === undefined) throw new Error('Reviewed schedule missing');
  const graph = {
    ...descriptor.manifest.graph,
    nodes: descriptor.manifest.graph.nodes.map((node) =>
      node.id === 'batch-items'
        ? {
            ...node,
            inputMappings: {
              ...node.inputMappings,
              items: { kind: 'literal' as const, value: [] },
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
    runId: 'owned-empty-loop',
    occurredAt: '2026-10-02T00:00:00.000Z',
    maximumAdmissions: 1,
    signal: new AbortController().signal,
  } as const;
  const checkpoint = createCheckpointV2({
    engineVersion: 'engine-v1',
    workflowVersionId: version,
    iterationBudget: 3,
  });
  let result = await advanceWorkflow({ ...base, checkpoint, observations: [] });
  for (const [ordinal, value] of [
    curatedScheduleInputCase,
    { items: [], iterationCount: 0 },
  ].entries()) {
    const attempt = result.attempts[0];
    if (attempt === undefined) throw new Error('Reviewed attempt missing');
    expect(attempt.nodeId).toBe(
      ordinal === 0 ? 'schedule-start' : 'batch-items',
    );
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
  expect(result.immediateContinuation).toBe(true);
  result = await advanceWorkflow({
    ...base,
    checkpoint: result.checkpoint,
    observations: [],
  });
  expect(result.attempts.map((attempt) => attempt.nodeId)).toEqual([
    'batch-complete',
  ]);
});
