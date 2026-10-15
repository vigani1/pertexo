import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  inputRequestConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
  type AdvanceWorkflowInput,
  type WorkflowCheckpoint,
  type PendingTaskOutcome,
} from '../../src/index.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';
import { completion } from '../compilation/calls/fixtures.js';
async function waitingRequest() {
  const base = graph();
  const workflow: WorkflowGraph = {
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === 'set'
        ? {
            ...node,
            definition: { key: 'core.request_input', version: 1 },
            config: inputRequestConfigSchema.parse({}),
            inputMappings: {},
          }
        : node,
    ),
  };
  const versionId = randomUUID();
  const executable = buildWorkflowExecutable({
    graph: workflow,
    catalog: composeExecutableCatalog(nodeCatalog({ inputRequest: true })),
  });
  const advance = (
    checkpoint: WorkflowCheckpoint,
    extra: Partial<AdvanceWorkflowInput> = {},
  ) =>
    advanceWorkflow({
      runId: randomUUID(),
      workflowVersionId: versionId,
      executable,
      checkpoint,
      occurredAt: '2026-10-15T12:00:00.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
      ...extra,
    });
  const initial = await advance(
    createCheckpoint({ workflowVersionId: versionId, iterationBudget: 200 }),
  );
  const declared = await advance(initial.checkpoint, completion(initial));
  const waiting = await advance(
    declared.checkpoint,
    completion(declared, { pending: true }),
  );
  const owner = waiting.checkpoint.invocations.find(
    (owner) => owner.waitKind === 'human_task',
  );
  if (owner === undefined) throw new Error('Missing input request');
  const fact: PendingTaskOutcome = {
    taskId: randomUUID(),
    nodeId: owner.nodeId,
    invocationKey: owner.invocationKey,
    status: 'submitted',
  };
  return { advance, waiting, fact };
}
it('declares the captured input form once and continues through out only after a submitted fact', async () => {
  const { advance, waiting, fact } = await waitingRequest();
  expect(waiting.taskIntents?.[0]).toMatchObject({
    kind: 'input_request',
    config: { fields: [{ name: 'message' }] },
  });
  expect(waiting.checkpoint.runStatus).toBe('waiting');
  expect(waiting.attempts).toEqual([]);
  const duplicate = await advance(
    parseCheckpoint(JSON.parse(JSON.stringify(waiting.checkpoint))),
  );
  expect(duplicate.taskIntents).toBeUndefined();
  const next = await advance(duplicate.checkpoint, {
    taskOutcomes: [fact, fact],
  });
  expect(next.attempts.map((item) => item.nodeId)).toEqual(['terminate']);
  const terminal = await advance(next.checkpoint, completion(next));
  expect(terminal.checkpoint.runStatus).toBe('succeeded');
});
it('refuses approval decisions as evidence for an input response', async () => {
  const { advance, waiting, fact } = await waitingRequest();
  await expect(
    advance(waiting.checkpoint, {
      taskOutcomes: [{ ...fact, status: 'approved' }],
    }),
  ).rejects.toThrow(/kind conflicts/u);
});
it('expires as a definite human-task failure rather than retrying the declaration', async () => {
  const { advance, waiting, fact } = await waitingRequest();
  const expired = await advance(waiting.checkpoint, {
    taskOutcomes: [{ ...fact, status: 'expired' }],
  });
  expect(expired.checkpoint.runStatus).toBe('failed');
  expect(expired.attempts).toEqual([]);
  expect(expired.events).toContainEqual(
    expect.objectContaining({
      name: 'node.failed',
      reasonCode: 'pending_task.expired',
    }),
  );
});
