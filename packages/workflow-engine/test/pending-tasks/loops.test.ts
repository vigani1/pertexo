import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  approvalConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
  type WorkflowCheckpoint,
  type AdvanceWorkflowInput,
  type PendingTaskOutcome,
} from '../../src/index.js';
import { forEachGraph, nodeCatalog } from '../support/executable-workflow.js';
import { completion } from '../compilation/calls/fixtures.js';
it('retains an unfinished loop approval, prunes only its decided scope and ignores retained duplicate outcomes', async () => {
  const original = forEachGraph();
  const graph: WorkflowGraph = {
    ...original,
    nodes: original.nodes.map((node) => {
      if (node.id !== 'loop' || !('structured' in node)) return node;
      const first = node.structured.body.nodes[0];
      if (first === undefined) throw new Error('Missing body');
      return {
        ...node,
        structured: {
          ...node.structured,
          maxConcurrency: 1,
          body: {
            ...node.structured.body,
            nodes: [
              {
                ...first,
                id: 'approval',
                definition: { key: 'core.approval', version: 1 },
                config: approvalConfigSchema.parse({}),
                inputMappings: {},
              },
            ],
            edges: [],
          },
        },
      };
    }),
  };
  const version = randomUUID();
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(
      nodeCatalog({ forEach: true, approval: true }),
    ),
  });
  const advance = (
    checkpoint: WorkflowCheckpoint,
    facts: Partial<AdvanceWorkflowInput> = {},
  ) =>
    advanceWorkflow({
      workflowVersionId: version,
      runId: randomUUID(),
      executable,
      checkpoint,
      occurredAt: '2026-10-15T00:00:00.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
      ...facts,
    });
  const initial = await advance(
    createCheckpoint({ workflowVersionId: version, iterationBudget: 200 }),
  );
  const collection = await advance(initial.checkpoint, completion(initial));
  const body = await advance(
    collection.checkpoint,
    completion(collection, { items: ['a', 'b'], iterationCount: 2 }),
  );
  const waiting = await advance(
    body.checkpoint,
    completion(body, { pending: true }),
  );
  expect(waiting.checkpoint.loops[0]?.completedPrefix).toBe(0);
  expect(waiting.attempts).toEqual([]);
  const owner = waiting.checkpoint.invocations.find(
    (item) => item.nodeId === 'approval',
  );
  if (owner === undefined) throw new Error('Missing approval');
  const fact: PendingTaskOutcome = {
    taskId: randomUUID(),
    nodeId: owner.nodeId,
    invocationKey: owner.invocationKey,
    branchPath: owner.branchPath ?? [],
    iterationPath: owner.iterationPath ?? [],
    status: 'approved',
  };
  const next = await advance(
    parseCheckpoint(JSON.parse(JSON.stringify(waiting.checkpoint))),
    { taskOutcomes: [fact] },
  );
  expect(next.checkpoint.loops[0]?.completedPrefix).toBe(1);
  expect(next.prunedInvocations).toContainEqual(
    expect.objectContaining({
      invocationKey: fact.invocationKey,
      output: { kind: 'task', taskId: fact.taskId },
    }),
  );
  expect(next.attempts[0]?.iterationPath).toEqual([
    { loopNodeId: 'loop', ordinal: 1 },
  ]);
  const duplicate = await advance(next.checkpoint, { taskOutcomes: [fact] });
  expect(duplicate.events).toEqual([]);
  expect(duplicate.attempts).toEqual([]);
  const waitingAgain = await advance(
    duplicate.checkpoint,
    completion(next, { pending: true }),
  );
  const second = waitingAgain.checkpoint.invocations.find(
    (item) => item.nodeId === 'approval',
  );
  if (second === undefined) throw new Error('Missing second task');
  const done = await advance(waitingAgain.checkpoint, {
    taskOutcomes: [
      fact,
      {
        ...fact,
        taskId: randomUUID(),
        invocationKey: second.invocationKey,
        iterationPath: second.iterationPath ?? [],
        status: 'rejected',
      },
    ],
  });
  expect(done.checkpoint.loops[0]?.completedPrefix).toBe(2);
  expect(
    done.checkpoint.invocations.some((item) => item.nodeId === 'approval'),
  ).toBe(false);
});
