import { Queue } from 'bullmq';
import { QUEUE_NAME } from '@pertexo/queue';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';

import { callbackTokenHash } from '@pertexo/integrations/server';
import {
  accept,
  edge,
  fixture,
  node,
  publishGraph,
  runtime,
} from '../../../calls/fixtures.js';
import { callbackResources } from '../fixtures.js';
import { wait, reply } from './fixture.js';

export function registerRevokesUnusedPreparedWaitAfterBranch(): void {
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
