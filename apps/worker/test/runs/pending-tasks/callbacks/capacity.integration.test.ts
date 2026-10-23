import { Queue } from 'bullmq';
import { QUEUE_NAME } from '@pertexo/queue';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callbackWaitConfigSchema,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import { callbackTokenHash } from '@pertexo/integrations/server';
import {
  accept,
  edge,
  fixture,
  limitWorkspace,
  node,
  parentGraph,
  publishGraph,
  runtime,
} from '../../calls/fixtures.js';
import { callbackResources } from './fixtures.js';

const wait = (id: string) => ({
  ...node(id, 'core.wait'),
  config: callbackWaitConfigSchema.parse({
    mode: 'callback',
    timeoutSeconds: 60,
  }),
});
async function reply(
  resources: ReturnType<typeof callbackResources>,
  id: string,
) {
  const signal = AbortSignal.timeout(5_000);
  const callback = await resources.store.resolve(
    callbackTokenHash(resources.keys.material({ id }, '1').token),
    signal,
  );
  if (callback === null) throw new Error('Missing callback');
  await resources.store.respond({
    callback,
    output: { body: { value: 'resumed' }, headers: {} },
    redactOutput: (text) => text,
    signal,
  });
}
function loop(id: string, body: WorkflowNode): WorkflowNode {
  return {
    ...node(id, 'core.foreach'),
    inputMappings: { items: { kind: 'literal', value: [1, 2] } },
    structured: {
      kind: 'for_each',
      maxIterations: 2,
      maxConcurrency: 2,
      body: {
        settings: {},
        nodes: [body],
        edges: [],
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
}

describe.runIf(fixture.enabled)(
  'Callback waits in structured work and shared Call slots',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    registerPausesNestedCallChainInsideOne();

    registerRevokesUnusedPreparedWaitAfterBranch();
  },
);

function registerPausesNestedCallChainInsideOne(): void {
  it('pauses a nested Call chain inside one slot and resumes the original parent', async () => {
    await limitWorkspace(1);
    const leaf: WorkflowGraph = {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [node('manual', 'core.manual'), wait('wait')],
      edges: [edge('manual', 'wait')],
      callable: {
        input: {
          type: 'object',
          properties: [
            { name: 'name', valueType: { type: 'string' }, required: true },
          ],
        },
        resultType: { type: 'string' },
        result: { kind: 'node_output', nodeId: 'wait', path: '$.body.value' },
      },
    };
    const child = await publishGraph(leaf);
    const middle = await publishGraph(parentGraph(child.pin));
    const parent = await publishGraph(parentGraph(middle.pin));
    const run = await accept(parent);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    try {
      let id = '';
      await workers.until(async () => {
        const tasks = await fixture.workerQuery<{ id: string }>(
          "select id from app.pending_run_tasks where workspace_id=$1 and status='pending'",
          [fixture.workspaceId],
        );
        expect(tasks).toHaveLength(1);
        id = tasks[0]?.id ?? '';
        expect(
          await fixture.workerQuery(
            "select count(*)::int n from app.workflow_runs where workspace_id=$1 and status='waiting' and human_wait_started_at is not null",
            [fixture.workspaceId],
          ),
        ).toEqual([{ n: 3 }]);
        expect(
          await fixture.workerQuery(
            'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
            [fixture.workspaceId],
          ),
        ).toEqual([{ occupied: 0 }]);
      });
      await workers.restart();
      await reply(resources, id);
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'resumed' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          'select count(*)::int n from app.workflow_run_active_admissions where workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).toEqual([{ n: 0 }]);
    } finally {
      await workers.close();
      await resources.close();
      await limitWorkspace(5);
    }
  }, 40_000);

  it('gives each nested loop iteration its own callback identity and releases its slot while all four wait', async () => {
    const version = await publishGraph({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        loop('outer', loop('inner', wait('wait'))),
      ],
      edges: [edge('manual', 'outer')],
    });
    const run = await accept(version);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    try {
      let tasks: readonly { id: string; callback_scope_hash: string }[] = [];
      await workers.until(async () => {
        tasks = await fixture.workerQuery(
          "select id,callback_scope_hash from app.pending_run_tasks where run_id=$1 and status='pending'",
          [run.runId],
        );
        expect(tasks).toHaveLength(4);
        expect(
          new Set(tasks.map((task) => task.callback_scope_hash)).size,
        ).toBe(4);
        expect(
          await fixture.workerQuery(
            'select status,human_wait_started_at is not null paused from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'waiting', paused: true }]);
      });
      await workers.restart();
      await Promise.all(tasks.map((task) => reply(resources, task.id)));
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
      expect(
        await fixture.workerQuery(
          'select count(*)::int n from app.pending_run_tasks where run_id=$1 and consumed_at is not null',
          [run.runId],
        ),
      ).toEqual([{ n: 4 }]);
    } finally {
      await workers.close();
      await resources.close();
    }
  }, 40_000);

  it('keeps independent parallel callbacks and releases capacity while both wait', async () => {
    const version = await publishGraph({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('parallel', 'core.parallel'),
          config: {
            branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
            maxConcurrency: 2,
          },
        },
        wait('first'),
        wait('second'),
        {
          ...node('merge', 'core.merge'),
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        },
      ],
      edges: [
        edge('manual', 'parallel'),
        edge('parallel', 'first', 'branch-01'),
        edge('parallel', 'second', 'branch-02'),
        {
          ...edge('first', 'merge'),
          target: { nodeId: 'merge', port: 'branch-01' },
        },
        {
          ...edge('second', 'merge'),
          target: { nodeId: 'merge', port: 'branch-02' },
        },
      ],
    });
    const run = await accept(version);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    try {
      let tasks: readonly { id: string; callback_token_hash: string }[] = [];
      await workers.until(async () => {
        tasks = await fixture.workerQuery(
          "select id,callback_token_hash from app.pending_run_tasks where run_id=$1 and status='pending'",
          [run.runId],
        );
        expect(tasks).toHaveLength(2);
        expect(
          new Set(tasks.map((task) => task.callback_token_hash)).size,
        ).toBe(2);
        expect(
          await fixture.workerQuery(
            'select status,human_wait_started_at is not null paused from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'waiting', paused: true }]);
        expect(
          await fixture.workerQuery(
            'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
            [fixture.workspaceId],
          ),
        ).toEqual([{ occupied: 0 }]);
      });
      await workers.restart();
      await Promise.all(tasks.map((task) => reply(resources, task.id)));
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
    } finally {
      await workers.close();
      await resources.close();
    }
  }, 30_000);
}

function registerRevokesUnusedPreparedWaitAfterBranch(): void {
  it('revokes an unused prepared Wait after its branch closes while a later callback keeps the run alive', async () => {
    let sentUrl = '';
    const registry = createPlatformNodeRegistry({
      httpRequest: {
        httpClient: {
          executeStreaming: async (request, consume) => {
            sentUrl = new URL(request.url).searchParams.get('callback') ?? '';
            await request.beforeDispatch();
            const response = {
              status: 200,
              headers: {},
              body: Readable.from([]),
              bodyEncoding: 'utf8' as const,
              finalUrl: 'https://receiver.example.test/',
              redirectCount: 0,
              signal: request.signal ?? AbortSignal.timeout(5000),
            };
            return { ...response, body: await consume(response) };
          },
        },
      },
    });
    const version = await publishGraph({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('parallel', 'core.parallel'),
          config: {
            branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
            maxConcurrency: 2,
          },
        },
        {
          ...node('send', 'http.request'),
          config: {
            method: 'GET',
            url: 'https://receiver.example.test/?callback={callbackUrl}',
            headers: {},
            timeoutMillis: 5000,
            maxRedirects: 0,
            maxResponseBytes: 4096,
            inlineResponseBytes: 4096,
          },
          inputMappings: {
            callbackUrl: {
              kind: 'expression',
              language: 'jsonata',
              expression: '$lookup($execution.callbacks,"unused").url',
            },
          },
        },
        {
          ...node('choice', 'core.condition'),
          inputMappings: { condition: { kind: 'literal', value: false } },
        },
        wait('unused'),
        node('pass', 'core.set'),
        wait('sibling'),
        {
          ...node('merge', 'core.merge'),
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        },
      ],
      edges: [
        edge('manual', 'parallel'),
        edge('parallel', 'send', 'branch-01'),
        edge('send', 'choice'),
        edge('choice', 'unused', 'true'),
        edge('choice', 'pass', 'false'),
        edge('parallel', 'sibling', 'branch-02'),
        {
          ...edge('pass', 'merge'),
          target: { nodeId: 'merge', port: 'branch-01' },
        },
        {
          ...edge('sibling', 'merge'),
          target: { nodeId: 'merge', port: 'branch-02' },
        },
      ],
    });
    const run = await accept(version);
    const resources = callbackResources();
    const workers = await runtime(registry, resources.capabilities);
    const diagnostics = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: fixture.redisConnection(),
    });
    try {
      let sibling = '';
      await workers.until(async () => {
        const tasks = await fixture.workerQuery<{
          id: string;
          callback_node_id: string;
          status: string;
          consumed: boolean;
        }>(
          'select id,callback_node_id,status,consumed_at is not null consumed from app.pending_run_tasks where run_id=$1 order by callback_node_id',
          [run.runId],
        );
        expect(
          await fixture.workerQuery(
            "select node_id,status from app.node_runs where workflow_run_id=$1 and node_id='unused'",
            [run.runId],
          ),
        ).toEqual([{ node_id: 'unused', status: 'skipped' }]);
        expect(tasks).toHaveLength(2);
        expect(tasks).toMatchObject([
          { callback_node_id: 'sibling', status: 'pending', consumed: false },
          { callback_node_id: 'unused', status: 'canceled', consumed: true },
        ]);
        sibling = tasks[0]?.id ?? '';
        const [current] = await fixture.workerQuery<{ status: string }>(
          'select status from app.workflow_runs where id=$1',
          [run.runId],
        );
        expect(['running', 'waiting']).toContain(current?.status);
      });
      const signal = AbortSignal.timeout(5000);
      const token = new URL(sentUrl).pathname.split('/')[2] ?? '';
      const closed = await resources.store.resolve(
        callbackTokenHash(token),
        signal,
      );
      if (closed === null) throw new Error('Missing prepared callback');
      await expect(
        resources.store.respond({
          callback: closed,
          output: { body: {}, headers: {} },
          redactOutput: (text) => text,
          signal,
        }),
      ).rejects.toMatchObject({ reason: 'closed' });
      await reply(resources, sibling);
      await workers.until(async () => {
        expect(
          (await diagnostics.getFailed(0, 10)).map((job) => job.failedReason),
        ).toEqual([]);
        expect(
          await fixture.workerQuery(
            'select node_id,status from app.node_runs where workflow_run_id=$1 order by node_id',
            [run.runId],
          ),
        ).toEqual(
          [
            'choice',
            'manual',
            'merge',
            'parallel',
            'pass',
            'send',
            'sibling',
            'unused',
          ].map((id) => ({
            node_id: id,
            status: id === 'unused' ? 'skipped' : 'succeeded',
          })),
        );
      });
    } finally {
      await diagnostics.close();
      await workers.close();
      await resources.close();
    }
  }, 30_000);
}
