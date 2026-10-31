import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import {
  ownWorkspace,
  publishGraph,
  readRun,
  runReaches,
  signUp,
  startRun,
  step,
  usageCapacity,
  type StackOwner,
} from '../../support/real-stack/owner.js';
import { createRealStack } from '../../support/real-stack/stack.js';

function manualThen(...steps: ReturnType<typeof step>[]) {
  const nodes = [step('manual', 'core.manual', 0), ...steps];
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${String(index)}`,
      source: { nodeId: String(nodes[index]?.id), port: 'out' },
      target: { nodeId: node.id, port: 'in' },
    })),
  };
}

const sleepsFor = (durationSeconds: number) =>
  manualThen(
    step('wait', 'core.wait', 200, { durationSeconds }),
    step('stop', 'core.terminate', 400),
  );

/** A service that keeps an HTTP step at work until the test lets it finish. */
async function stallingService() {
  let arrived: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server: Server = createServer((_request, response) => {
    arrived();
    void released.then(() => response.writeHead(200).end('{}'));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Stalling service has no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/work`,
    reached,
    release,
    close: () => {
      release();
      server.closeAllConnections();
      server.close();
    },
  };
}

const workOn = (url: string) =>
  manualThen(
    step('work', 'http.request', 200, {
      method: 'GET',
      url,
      headers: {},
      timeoutMillis: 120_000,
      maxRedirects: 0,
      maxResponseBytes: 4096,
      inlineResponseBytes: 4096,
    }),
    step('stop', 'core.terminate', 400),
  );

async function limitRunsAtOnce(owner: StackOwner, path: string, limit: number) {
  const read = await owner.send('GET', `${path}/concurrency`);
  expect(read.status).toBe(200);
  const { revision } = (await read.json()) as { revision: number };
  const changed = await owner.send('PUT', `${path}/concurrency`, {
    limit,
    expectedRevision: revision,
    overflow: 'queue',
  });
  expect(changed.status, await changed.text()).toBe(200);
}

const FINISHED = new Set(['succeeded', 'failed', 'canceled', 'timed_out']);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'runs in a timed Wait on real API and worker processes',
  () => {
    const stack = createRealStack('timed-waits');
    let send: Awaited<ReturnType<typeof signUp>> | undefined;

    beforeAll(() => stack.create(), 120_000);
    afterAll(() => stack.close(), 60_000);

    async function newWorkspace(origin: string) {
      send ??= await signUp(stack, origin);
      return ownWorkspace(send);
    }

    it('keeps a woken Wait waiting while every slot is at work, and finishes it once one frees', async () => {
      const service = await stallingService();
      const running = await stack.boot({
        WORKSPACE_ACTIVE_RUN_LIMIT: '1',
        HTTP_ALLOWED_PRIVATE_NETWORKS: '127.0.0.1/32',
      });
      try {
        const owner = await newWorkspace(running.origin);
        const sleeps = await publishGraph(owner, 'Sleeps', sleepsFor(10));
        const works = await publishGraph(owner, 'Works', workOn(service.url));

        const sleepStarted = Date.now();
        const sleeper = await startRun(owner, sleeps.path);
        await runReaches(owner, sleeper, 'waiting');
        expect((await usageCapacity(owner)).execution.activeRuns).toBe(0);

        const worker = await startRun(owner, works.path);
        await service.reached;
        await runReaches(owner, worker, 'running');
        expect(Date.now() - sleepStarted).toBeLessThan(10_000);

        // Past the Wait's end by more than the few seconds a woken run defers at a time.
        while (Date.now() - sleepStarted < 18_000) {
          expect((await readRun(owner, sleeper)).status).toBe('waiting');
          const { activeRuns } = (await usageCapacity(owner)).execution;
          expect(activeRuns).toBe(1);
          await delay(500);
        }

        service.release();
        await runReaches(owner, worker, 'succeeded');
        await runReaches(owner, sleeper, 'succeeded');
        expect((await usageCapacity(owner)).execution.activeRuns).toBe(0);
      } finally {
        service.close();
        await running.stop();
      }
    }, 180_000);

    it('keeps the next run queued behind a sleeping run at a workflow limit of 1, with workspace slots free', async () => {
      const running = await stack.boot();
      try {
        const owner = await newWorkspace(running.origin);
        const { path } = await publishGraph(owner, 'One', sleepsFor(6));
        await limitRunsAtOnce(owner, path, 1);

        const first = await startRun(owner, path);
        await runReaches(owner, first, 'waiting');
        expect((await usageCapacity(owner)).execution.activeRuns).toBe(0);
        const next = await startRun(owner, path);

        let sampled = 0;
        for (;;) {
          // The next run first, so it's never read after the first has already finished.
          const nextStatus = (await readRun(owner, next)).status;
          const firstStatus = (await readRun(owner, first)).status;
          if (FINISHED.has(firstStatus)) break;
          expect(nextStatus).toBe('queued');
          sampled += 1;
          await delay(250);
        }
        expect(sampled).toBeGreaterThan(3);

        expect((await readRun(owner, first)).status).toBe('succeeded');
        await runReaches(owner, next, 'succeeded');
      } finally {
        await running.stop();
      }
    }, 180_000);
  },
);
