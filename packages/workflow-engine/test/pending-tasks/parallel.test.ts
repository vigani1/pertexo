import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  approvalConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type AdvanceWorkflowInput,
  type WorkflowCheckpoint,
  type PendingTaskOutcome,
} from '../../src/index.js';
import {
  pairedParallelGraph,
  nodeCatalog,
} from '../support/executable-workflow.js';
import { completion } from '../compilation/calls/fixtures.js';
it('waits on human branches and their structural Merge without hiding an active sibling', async () => {
  const base = pairedParallelGraph();
  const graph: WorkflowGraph = {
    ...base,
    nodes: base.nodes.map((node) =>
      ['left', 'right'].includes(node.id)
        ? {
            ...node,
            definition: { key: 'core.approval', version: 1 },
            config: approvalConfigSchema.parse({}),
            inputMappings: {},
          }
        : node,
    ),
    edges: base.edges.map((edge) =>
      ['left', 'right'].includes(edge.source.nodeId)
        ? { ...edge, source: { ...edge.source, port: 'approved' } }
        : edge,
    ),
  };
  const version = randomUUID();
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(
      nodeCatalog({ approval: true, parallel: true, merge: true }),
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
  const parallel = await advance(initial.checkpoint, completion(initial));
  const first = await advance(
    parallel.checkpoint,
    completion(parallel, { branchIds: ['branch-02', 'branch-01'] }),
  );
  const sibling = await advance(
    first.checkpoint,
    completion(first, { pending: true }),
  );
  expect(sibling.attempts).toHaveLength(1);
  expect(sibling.checkpoint.runStatus).toBe('running');
  const waiting = await advance(
    sibling.checkpoint,
    completion(sibling, { pending: true }),
  );
  expect(waiting.checkpoint.runStatus).toBe('waiting');
  expect(waiting.checkpoint.joins).toHaveLength(1);
  expect(waiting.attempts).toEqual([]);
  const tasks: PendingTaskOutcome[] = waiting.checkpoint.invocations
    .filter((owner) => owner.waitKind === 'human_task')
    .map((owner) => ({
      taskId: randomUUID(),
      nodeId: owner.nodeId,
      invocationKey: owner.invocationKey,
      branchPath: owner.branchPath ?? [],
      iterationPath: owner.iterationPath ?? [],
      status: 'approved',
    }));
  expect(tasks).toHaveLength(2);
  const one = tasks[0];
  if (one === undefined) throw new Error('Missing task');
  const half = await advance(waiting.checkpoint, { taskOutcomes: [one] });
  expect(half.checkpoint.runStatus).toBe('waiting');
  expect(half.attempts).toEqual([]);
  const resumed = await advance(half.checkpoint, { taskOutcomes: tasks });
  expect(resumed.attempts.map((item) => item.nodeId)).toEqual(['merge']);
  expect(resumed.checkpoint.runStatus).toBe('running');
});
