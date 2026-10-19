import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  approvalConfigSchema,
  type JsonValue,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
  type AdvanceWorkflowInput,
  type PendingTaskOutcome,
  type WorkflowCheckpoint,
} from '../../src/index.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';
import { completion } from '../compilation/calls/fixtures.js';

const at = '2026-10-15T00:00:00.000Z';
function fixture(
  withHandler = false,
  config: Readonly<Record<string, JsonValue>> = approvalConfigSchema.parse({}),
) {
  const base = graph();
  const workflow: WorkflowGraph = {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'approval',
        definition: { key: 'core.approval', version: 1 },
        config,
        inputMappings: {},
      },
      { ...base.nodes[2], id: 'approved-stop', inputMappings: {} },
      { ...base.nodes[2], id: 'rejected-stop', inputMappings: {} },
      ...(withHandler
        ? [
            {
              ...base.nodes[1],
              id: 'handler',
              inputMappings: {
                reason: {
                  kind: 'node_failure' as const,
                  nodeId: 'approval',
                  path: '$.safeErrorCode',
                },
              },
            },
            { ...base.nodes[2], id: 'handler-stop', inputMappings: {} },
          ]
        : []),
    ],
    edges: [
      {
        id: 'start',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'approval', port: 'in' },
      },
      ...(['approved', 'rejected'] as const).map((port) => ({
        id: port,
        source: { nodeId: 'approval', port },
        target: { nodeId: `${port}-stop`, port: 'in' },
      })),
      ...(withHandler
        ? [
            {
              id: 'failure',
              source: { nodeId: 'approval', port: '__failure' },
              target: { nodeId: 'handler', port: 'in' },
            },
            {
              id: 'handled',
              source: { nodeId: 'handler', port: 'out' },
              target: { nodeId: 'handler-stop', port: 'in' },
            },
          ]
        : []),
    ],
  };
  const version = randomUUID();
  const executable = buildWorkflowExecutable({
    graph: workflow,
    catalog: composeExecutableCatalog(nodeCatalog({ approval: true })),
  });
  const advance = (
    checkpoint: WorkflowCheckpoint,
    extra: Partial<AdvanceWorkflowInput> = {},
  ) =>
    advanceWorkflow({
      workflowVersionId: version,
      runId: randomUUID(),
      executable,
      checkpoint,
      occurredAt: at,
      maximumAdmissions: 10,
      signal: new AbortController().signal,
      ...extra,
    });
  const initial = () =>
    advance(
      createCheckpoint({ workflowVersionId: version, iterationBudget: 200 }),
    );
  return { advance, initial };
}
async function declared(
  withHandler = false,
  config?: Readonly<Record<string, JsonValue>>,
) {
  const run = fixture(withHandler, config);
  const initial = await run.initial();
  const preparation = await run.advance(
    initial.checkpoint,
    completion(initial),
  );
  const waiting = await run.advance(
    preparation.checkpoint,
    completion(preparation, { pending: true }),
  );
  const owner = waiting.checkpoint.invocations.find(
    ({ nodeId }) => nodeId === 'approval',
  );
  if (owner === undefined) throw new Error('Approval missing');
  const fact: PendingTaskOutcome = {
    taskId: randomUUID(),
    nodeId: owner.nodeId,
    invocationKey: owner.invocationKey,
    status: 'approved',
  };
  return { run, waiting, fact };
}

it('declares once, persists a human wait without a worker, and survives checkpoint parsing', async () => {
  const { run, waiting } = await declared();
  expect(waiting.taskIntents).toHaveLength(1);
  expect(waiting.taskIntents?.[0]?.config.expiresAfterSeconds).toBe(604800);
  expect(waiting.checkpoint.runStatus).toBe('waiting');
  expect(waiting.attempts).toEqual([]);
  expect(
    waiting.checkpoint.invocations.find(({ nodeId }) => nodeId === 'approval'),
  ).toMatchObject({ status: 'waiting', waitKind: 'human_task' });
  const next = await run.advance(
    parseCheckpoint(JSON.parse(JSON.stringify(waiting.checkpoint))),
  );
  expect(next.taskIntents).toBeUndefined();
  expect(next.attempts).toEqual([]);
  expect(next.events).toEqual([]);
  expect(next.immediateContinuation).toBeUndefined();
});
it('captures the default audience and expiry for a step left on its defaults', async () => {
  // A step saved without touching Setup has no audience or expiry in its
  // config; who may answer and when it expires are read from the task.
  const { waiting } = await declared(false, { title: 'Refund over limit' });
  expect(waiting.taskIntents?.[0]?.config).toMatchObject({
    title: 'Refund over limit',
    audience: { roles: ['owner', 'admin'], memberIds: [] },
    expiresAfterSeconds: 604800,
  });
});
it.each(['approved', 'rejected'] as const)(
  'continues only the %s path once',
  async (status) => {
    const { run, waiting, fact } = await declared();
    const accepted = { ...fact, status };
    const next = await run.advance(waiting.checkpoint, {
      taskOutcomes: [accepted, accepted],
    });
    expect(next.attempts.map(({ nodeId }) => nodeId)).toEqual([
      `${status}-stop`,
    ]);
    expect(
      next.checkpoint.invocations.find(({ nodeId }) => nodeId === 'approval')
        ?.output,
    ).toEqual({ kind: 'task', taskId: fact.taskId });
    const duplicate = await run.advance(next.checkpoint, {
      taskOutcomes: [accepted],
    });
    expect(duplicate.events).toEqual([]);
    expect(duplicate.attempts).toEqual([]);
    const finished = await run.advance(duplicate.checkpoint, completion(next));
    expect(finished.checkpoint.runStatus).toBe('succeeded');
  },
);
it('accepts the decision fact without capacity but admits no continuation until capacity returns', async () => {
  const { run, waiting, fact } = await declared();
  const blocked = await run.advance(waiting.checkpoint, {
    taskOutcomes: [fact],
    hasExecutionSlot: false,
  });
  expect(blocked.attempts).toEqual([]);
  expect(blocked.immediateContinuation).toBeUndefined();
  expect(blocked.checkpoint.readySet).toHaveLength(1);
  const granted = await run.advance(blocked.checkpoint, {
    hasExecutionSlot: true,
  });
  expect(granted.attempts.map(({ nodeId }) => nodeId)).toEqual([
    'approved-stop',
  ]);
});
it.each(['expired', 'refused'] as const)(
  'fails a %s task definitively, without retrying the declaration',
  async (status) => {
    const { run, waiting, fact } = await declared();
    const next = await run.advance(waiting.checkpoint, {
      taskOutcomes: [{ ...fact, status }],
    });
    expect(next.checkpoint.runStatus).toBe('failed');
    expect(next.attempts).toEqual([]);
    expect(next.events).toContainEqual(
      expect.objectContaining({
        name: 'node.failed',
        reasonCode:
          status === 'expired'
            ? 'pending_task.expired'
            : 'pending_task.capacity_exceeded',
      }),
    );
  },
);
it('routes expiry through the configured failure handler', async () => {
  const { run, waiting, fact } = await declared(true);
  const failed = await run.advance(waiting.checkpoint, {
    taskOutcomes: [{ ...fact, status: 'expired' }],
  });
  expect(failed.attempts.map(({ nodeId }) => nodeId)).toEqual(['handler']);
  expect(failed.failureValues?.[0]?.value).toMatchObject({
    errorKind: 'human_task',
    safeErrorCode: 'pending_task.expired',
  });
  const handled = await run.advance(failed.checkpoint, completion(failed));
  const finished = await run.advance(handled.checkpoint, completion(handled));
  expect(finished.checkpoint.runStatus).toBe('succeeded');
  expect(
    finished.checkpoint.invocations.find(({ nodeId }) => nodeId === 'approval')
      ?.failureHandling?.disposition,
  ).toBe('handled');
});
it('rejects conflicting decisions, foreign scopes, invalid references and arbitrary failure text', async () => {
  const { run, waiting, fact } = await declared();
  for (const outcomes of [
    [fact, { ...fact, status: 'rejected' }],
    [{ ...fact, nodeId: 'manual' }],
    [{ ...fact, taskId: 'invalid' }],
    [{ ...fact, reasonCode: 'private text' }],
  ])
    await expect(
      run.advance(waiting.checkpoint, { taskOutcomes: outcomes }),
    ).rejects.toThrow();
  const next = await run.advance(waiting.checkpoint, { taskOutcomes: [fact] });
  await expect(
    run.advance(next.checkpoint, {
      taskOutcomes: [{ ...fact, taskId: randomUUID() }],
    }),
  ).rejects.toThrow(/identity/u);
});
it('keeps cancellation authoritative over a late decision', async () => {
  const { run, waiting, fact } = await declared();
  const canceled = await run.advance(waiting.checkpoint, {
    observations: [
      {
        kind: 'cancel_requested',
        sequence: waiting.checkpoint.nextEventSequence,
        occurredAt: at,
      },
    ],
  });
  expect(canceled.checkpoint.runStatus).toBe('canceled');
  const late = await run.advance(canceled.checkpoint, { taskOutcomes: [fact] });
  expect(late.events).toEqual([]);
  expect(late.attempts).toEqual([]);
  expect(late.checkpoint.runStatus).toBe('canceled');
});
