import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import {
  createCapacityStack,
  publishGraph,
  ownWorkspace,
  signedDelivery,
  signUp,
  step,
  usageCapacity,
  type CapacityOwner,
} from './real-stack.js';

// The operator's settings, which ship in .env.example and need no SQL.
const OPERATOR_SETTINGS = {
  WORKSPACE_ACTIVE_RUN_LIMIT: '2',
  WORKSPACE_QUEUED_RUN_LIMIT: '3',
  WORKSPACE_FILE_LIMIT: '7',
  WEBHOOK_ENDPOINT_BURST_LIMIT: '5',
};

const waitGraph = {
  nodes: [
    step('manual', 'core.manual', 0),
    step('wait', 'core.wait', 200, { durationSeconds: 3_600 }),
    step('stop', 'core.terminate', 400),
  ],
  edges: [
    {
      id: 'manual-wait',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'wait', port: 'in' },
    },
    {
      id: 'wait-stop',
      source: { nodeId: 'wait', port: 'out' },
      target: { nodeId: 'stop', port: 'in' },
    },
  ],
};

const quickGraph = {
  nodes: [
    step('manual', 'core.manual', 0),
    step('stop', 'core.terminate', 200),
  ],
  edges: [
    {
      id: 'manual-stop',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'stop', port: 'in' },
    },
  ],
};

async function startRun(owner: CapacityOwner, path: string) {
  const started = await owner.send('POST', `${path}/runs`, { input: {} });
  const body = await started.text();
  expect(started.status, body).toBe(202);
  return (JSON.parse(body) as { run: { id: string } }).run.id;
}

async function runStatus(owner: CapacityOwner, runId: string) {
  const read = await owner.send('GET', `${owner.base}/runs/${runId}`);
  return ((await read.json()) as { run: { status: string } }).run.status;
}

async function runReaches(owner: CapacityOwner, runId: string, status: string) {
  await expect
    .poll(() => runStatus(owner, runId), { timeout: 30_000, interval: 250 })
    .toBe(status);
}

async function liveWebhook(owner: CapacityOwner) {
  const { path } = await publishGraph(owner, 'Burst', {
    nodes: [step('webhook', 'core.webhook', 0)],
    edges: [],
  });
  let triggerId: string | undefined;
  await expect
    .poll(
      async () => {
        const listed = await owner.send('GET', `${path}/triggers`);
        const { items } = (await listed.json()) as {
          items: { id: string; status: string }[];
        };
        triggerId = items.find(
          ({ status }) => status === 'configuration_required',
        )?.id;
        return triggerId !== undefined;
      },
      { timeout: 30_000, interval: 250 },
    )
    .toBe(true);
  const provisioned = await owner.send(
    'POST',
    `${path}/triggers/${String(triggerId)}/webhook/provision`,
  );
  expect(provisioned.status).toBe(200);
  return (await provisioned.json()) as {
    endpointKey: string;
    signingSecret: string;
  };
}

describe.skipIf(!betterAuthIntegrationEnabled)(
  'capacity an operator sets on real API and worker processes',
  () => {
    const stack = createCapacityStack();

    let send: Awaited<ReturnType<typeof signUp>> | undefined;

    beforeAll(() => stack.create(), 120_000);
    afterAll(() => stack.close(), 60_000);

    async function newWorkspace(origin: string) {
      send ??= await signUp(stack, origin);
      return ownWorkspace(send);
    }

    // dm-07, performance-04: 5 active, 100 queued, 1,000 files, reachable only by SQL.
    it.fails(
      'gives a new workspace sensible higher defaults',
      async () => {
        const running = await stack.boot();
        try {
          const owner = await newWorkspace(running.origin);
          const { execution, artifacts } = await usageCapacity(owner);
          expect(execution.policy.activeRunLimit).toBeGreaterThanOrEqual(20);
          expect(execution.policy.queuedRunLimit).toBeGreaterThanOrEqual(
            10_000,
          );
          expect(artifacts.artifactCountLimit).toBeGreaterThanOrEqual(10_000);
        } finally {
          await running.stop();
        }
      },
      120_000,
    );

    // dm-07, performance-04: there is no setting to read.
    it.fails(
      'applies the operator’s settings to new and existing workspaces after a restart',
      async () => {
        const first = await stack.boot(OPERATOR_SETTINGS);
        let owner: CapacityOwner;
        try {
          owner = await newWorkspace(first.origin);
          const { execution, artifacts } = await usageCapacity(owner);
          expect(execution.policy).toMatchObject({
            activeRunLimit: 2,
            queuedRunLimit: 3,
          });
          expect(artifacts.artifactCountLimit).toBe(7);
        } finally {
          await first.stop();
        }
        const second = await stack.boot({
          ...OPERATOR_SETTINGS,
          WORKSPACE_ACTIVE_RUN_LIMIT: '9',
        });
        try {
          const raised = await usageCapacity(owner);
          expect(raised.execution.policy.activeRunLimit).toBe(9);
          const fresh = await usageCapacity(await newWorkspace(second.origin));
          expect(fresh.execution.policy.activeRunLimit).toBe(9);
        } finally {
          await second.stop();
        }
      },
      180_000,
    );

    // dm-07: the setting has one validation, at the boundary, and a bad value says so.
    it.fails(
      'refuses to start on a limit that isn’t a number',
      async () => {
        const refused = await stack.bootExitCode({
          WORKSPACE_ACTIVE_RUN_LIMIT: 'lots',
        });
        expect(refused.code).not.toBe(null);
        expect(refused.code).not.toBe(0);
        expect(refused.output).toContain('WORKSPACE_ACTIVE_RUN_LIMIT');
      },
      60_000,
    );

    // dm-07, performance-04: timed Waits hold their slot, so two of them stop everything else.
    it.fails(
      'lets other runs start while timed Waits fill what would be every active slot',
      async () => {
        const running = await stack.boot({
          WORKSPACE_ACTIVE_RUN_LIMIT: '2',
        });
        try {
          const owner = await newWorkspace(running.origin);
          const waiting = await publishGraph(owner, 'Sleeps', waitGraph);
          const quick = await publishGraph(owner, 'Quick', quickGraph);
          const sleepers = [
            await startRun(owner, waiting.path),
            await startRun(owner, waiting.path),
            await startRun(owner, waiting.path),
          ];
          for (const sleeper of sleepers)
            await runReaches(owner, sleeper, 'waiting');
          expect((await usageCapacity(owner)).execution.activeRuns).toBe(0);
          const next = await startRun(owner, quick.path);
          await runReaches(owner, next, 'succeeded');
        } finally {
          await running.stop();
        }
      },
      180_000,
    );

    it('finishes a run after its timed Wait ends', async () => {
      const running = await stack.boot();
      try {
        const owner = await newWorkspace(running.origin);
        const { path } = await publishGraph(owner, 'Short sleep', {
          ...waitGraph,
          nodes: [
            step('manual', 'core.manual', 0),
            step('wait', 'core.wait', 200, { durationSeconds: 1 }),
            step('stop', 'core.terminate', 400),
          ],
        });
        const run = await startRun(owner, path);
        await delay(500);
        await runReaches(owner, run, 'succeeded');
        expect(await runStatus(owner, run)).toBe('succeeded');
      } finally {
        await running.stop();
      }
    }, 120_000);

    // performance-04: a burst of 300 gives exactly 60 × 202 and 240 × 429, whatever the operator wants.
    it.fails(
      'applies the configured burst limit to a webhook endpoint',
      async () => {
        const running = await stack.boot(OPERATOR_SETTINGS);
        try {
          const owner = await newWorkspace(running.origin);
          const { endpointKey, signingSecret } = await liveWebhook(owner);
          const statuses: number[] = [];
          for (let sent = 0; sent < 7; sent += 1) {
            const response = await signedDelivery(
              running.origin,
              endpointKey,
              signingSecret,
            );
            statuses.push(response.status);
            await response.arrayBuffer();
          }
          expect(statuses).toEqual([202, 202, 202, 202, 202, 429, 429]);
        } finally {
          await running.stop();
        }
      },
      120_000,
    );

    it.fails(
      'takes more than the old burst of 60 when the operator raises the limit',
      async () => {
        const running = await stack.boot({
          WEBHOOK_ENDPOINT_BURST_LIMIT: '100',
          WORKSPACE_QUEUED_RUN_LIMIT: '1000',
        });
        try {
          const owner = await newWorkspace(running.origin);
          const { endpointKey, signingSecret } = await liveWebhook(owner);
          const responses = await Promise.all(
            Array.from({ length: 80 }, () =>
              signedDelivery(running.origin, endpointKey, signingSecret),
            ),
          );
          await Promise.all(responses.map((r) => r.arrayBuffer()));
          expect(new Set(responses.map(({ status }) => status))).toEqual(
            new Set([202]),
          );
        } finally {
          await running.stop();
        }
      },
      120_000,
    );
  },
);
