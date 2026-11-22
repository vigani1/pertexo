import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { runEventChannel } from '@pertexo/queue/server';
import { MCP_STATUS_TOOL_NAME } from '@pertexo/contracts';

import {
  publishGraph,
  step,
  type StackOwner,
} from '../support/real-stack/owner.js';
import { pendingReference, type mcpClient } from './client.js';
import { expose } from './exposure.js';

interface Credential {
  id: string;
  client: ReturnType<typeof mcpClient>;
}

export function mcpWaitCases({
  getOwner,
  credential,
  graph,
  runsOf,
}: Readonly<{
  getOwner: () => StackOwner;
  credential: (owner: StackOwner, name: string) => Promise<Credential>;
  graph: Parameters<typeof publishGraph>[2];
  runsOf: (workflowId: string) => Promise<readonly { id: string }[]>;
}>) {
  it('returns the declared result inline and projects the same result through status', async () => {
    const owner = getOwner();
    const { client } = await credential(owner, 'Inline client');
    const workflow = await publishGraph(owner, 'Inline result', graph);
    await expose(owner, workflow, 'inline_result');
    const key = randomUUID();
    const args = { name: 'Declared result' };
    const inline = await client.invoke('inline_result', args, { key });
    expect(inline).toMatchObject({
      isError: false,
      structuredContent: { status: 'completed', result: args.name },
    });
    const reference = pendingReference(
      await client.invoke('inline_result', args, { key, waitMillis: 0 }),
    );
    expect(await client.status(reference)).toEqual(inline);
  });

  it('returns pending after the bounded wait and reads the result later', async () => {
    await withBlockedRun(
      'slow_result',
      async ({ client, release, reached, subscribers }) => {
        // A hint above the server bound still returns while the worker is blocked.
        const call = client.invoke('slow_result', args, {
          waitMillis: 60_000,
          signal: AbortSignal.timeout(10_000),
        });
        await reached;
        await expect.poll(subscribers, { timeout: 1_000 }).toBe(1);
        const invocation = pendingReference(await call);
        expect((await client.status(invocation)).structuredContent.status).toBe(
          'pending',
        );
        release();
        await expectCompleted(client, invocation);
      },
    );
  });

  it('continues the accepted run when the caller disconnects during the wait', async () => {
    await withBlockedRun(
      'disconnect_result',
      async ({ client, release, reached, subscribers }) => {
        const controller = new AbortController();
        const key = randomUUID();
        const call = client.call('disconnect_result', args, {
          key,
          signal: controller.signal,
        });
        const rejected = expect(call).rejects.toMatchObject({
          name: 'AbortError',
        });
        await reached;
        await expect.poll(subscribers, { timeout: 1_000 }).toBe(1);
        const invocation = pendingReference(
          await client.invoke('disconnect_result', args, {
            key,
            waitMillis: 0,
          }),
        );
        controller.abort();
        await rejected;
        await expect.poll(subscribers, { timeout: 1_000 }).toBe(0);
        release();
        await expectCompleted(client, invocation);
      },
    );
  });

  it('withholds the result when the initiating token is revoked during the wait', async () => {
    await withBlockedRun(
      'revoked_result',
      async ({ client, id, release, reached, subscribers }) => {
        const key = randomUUID();
        const call = client.invoke('revoked_result', args, { key });
        await reached;
        const invocation = pendingReference(
          await client.invoke('revoked_result', args, { key, waitMillis: 0 }),
        );
        await expect.poll(subscribers, { timeout: 1_000 }).toBe(1);
        const owner = getOwner();
        const revoked = await owner.send(
          'POST',
          `${owner.base}/api-tokens/${id}/revoke`,
          {},
        );
        expect(revoked.status, await revoked.text()).toBe(200);
        release();
        expect(await call).toMatchObject({
          isError: true,
          structuredContent: { status: 'failed', code: 'unavailable' },
        });
        expect(
          (await client.call(MCP_STATUS_TOOL_NAME, { invocation })).status,
        ).toBe(401);
      },
    );
  });

  async function withBlockedRun(
    name: string,
    test: (
      input: Credential & {
        release: () => void;
        reached: Promise<void>;
        subscribers: () => Promise<number>;
      },
    ) => Promise<void>,
  ) {
    const owner = getOwner();
    const token = await credential(owner, name);
    const url = process.env.REDIS_URL;
    if (url === undefined) throw new Error('REDIS_URL is required');
    const service = await controlledHttpStep();
    const redis = new Redis(url);
    try {
      const workflow = await publishGraph(owner, name, {
        ...graph,
        nodes: [
          ...graph.nodes,
          step('work', 'http.request', 200, {
            method: 'GET',
            url: service.url,
            headers: {},
            timeoutMillis: 20_000,
            maxRedirects: 0,
            maxResponseBytes: 4096,
            inlineResponseBytes: 4096,
          }),
        ],
        edges: [
          {
            id: 'manual-work',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'work', port: 'in' },
          },
        ],
      });
      await expose(owner, workflow, name);
      await test({
        ...token,
        ...service,
        subscribers: async () => {
          const [run] = await runsOf(workflow.workflowId);
          if (run === undefined) throw new Error('No accepted run');
          const [, count] = await redis.pubsub(
            'NUMSUB',
            runEventChannel(owner.workspaceId, run.id),
          );
          return Number(count);
        },
      });
    } finally {
      redis.disconnect();
      await service.close();
    }
  }
}

const args = { name: 'Retained result' };

async function expectCompleted(
  client: Credential['client'],
  invocation: string,
) {
  await expect
    .poll(() => client.status(invocation), { timeout: 10_000 })
    .toMatchObject({
      isError: false,
      structuredContent: { status: 'completed', result: args.name },
    });
}

async function controlledHttpStep() {
  const reached = Promise.withResolvers<undefined>();
  const complete = Promise.withResolvers<undefined>();
  const server = createServer((_request, response) => {
    reached.resolve(undefined);
    void complete.promise.then(() => response.writeHead(200).end('{}'));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing HTTP step address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/work`,
    reached: reached.promise,
    release: () => {
      complete.resolve(undefined);
    },
    close: () => {
      complete.resolve(undefined);
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}
