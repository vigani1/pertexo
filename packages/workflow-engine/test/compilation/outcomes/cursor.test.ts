import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';

import { graph, nodeCatalog } from '../../support/executable-workflow.js';
describe('attempt outcome production operations', () => {
  it('starts derived events strictly after the consumed external high-water', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const sourceGraph = graph();
    const manualNode = sourceGraph.nodes[0];
    const singleNode = { ...sourceGraph, nodes: [manualNode], edges: [] };
    const executable = buildWorkflowExecutable({
      graph: singleNode,
      catalog,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const externalSequence = started.checkpoint.nextEventSequence;
    const completed = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'cursor_only',
          eventName: 'node.started',
          sequence: externalSequence,
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: manual.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000042',
          attemptNumber: manual.attemptNumber,
        },
        {
          sequence: externalSequence + 1,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000022',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(
      completed.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.succeeded', externalSequence + 2]]);
    expect(completed.consumedThroughEventSequence).toBe(externalSequence + 1);
    expect(completed.checkpoint.nextEventSequence).toBe(externalSequence + 3);
    expect(completed.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.started' }),
    );
  });
});
