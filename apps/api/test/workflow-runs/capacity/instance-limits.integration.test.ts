import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import {
  ownWorkspace,
  provisionWebhook,
  publishGraph,
  readRun,
  runReaches,
  signedDelivery,
  signUp,
  startRun,
  step,
  usageCapacity,
  type StackOwner,
} from '../../support/real-stack/owner.js';
import { createRealStack } from '../../support/real-stack/stack.js';

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

describe.skipIf(!betterAuthIntegrationEnabled)(
  'capacity an operator sets on real API and worker processes',
  () => {
    const stack = createRealStack('capacity');

    let send: Awaited<ReturnType<typeof signUp>> | undefined;

    beforeAll(() => stack.create(), 120_000);
    afterAll(() => stack.close(), 60_000);

    async function newWorkspace(origin: string) {
      send ??= await signUp(stack, origin);
      return ownWorkspace(send);
    }

    it('gives a new workspace sensible higher defaults', async () => {
      const running = await stack.boot();
      try {
        const owner = await newWorkspace(running.origin);
        const { execution, artifacts } = await usageCapacity(owner);
        expect(execution.policy.activeRunLimit).toBeGreaterThanOrEqual(20);
        expect(execution.policy.queuedRunLimit).toBeGreaterThanOrEqual(10_000);
        expect(artifacts.artifactCountLimit).toBeGreaterThanOrEqual(10_000);
      } finally {
        await running.stop();
      }
    }, 120_000);

    it('applies the operator’s settings to new and existing workspaces after a restart', async () => {
      const first = await stack.boot(OPERATOR_SETTINGS);
      let owner: StackOwner;
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
    }, 180_000);

    it('refuses to start on a limit that isn’t a number', async () => {
      const refused = await stack.bootExitCode({
        WORKSPACE_ACTIVE_RUN_LIMIT: 'lots',
      });
      expect(refused.code).not.toBe(null);
      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain('WORKSPACE_ACTIVE_RUN_LIMIT');
    }, 60_000);

    it('lets other runs start while timed Waits fill what would be every active slot', async () => {
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
    }, 180_000);

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
        expect((await readRun(owner, run)).status).toBe('succeeded');
      } finally {
        await running.stop();
      }
    }, 120_000);

    it('applies the configured burst limit to a webhook endpoint', async () => {
      const running = await stack.boot(OPERATOR_SETTINGS);
      try {
        const owner = await newWorkspace(running.origin);
        const { path } = await publishGraph(owner, 'Burst', {
          nodes: [step('webhook', 'core.webhook', 0)],
          edges: [],
        });
        const { endpointKey, signingSecret } = await provisionWebhook(
          owner,
          path,
        );
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
    }, 120_000);

    it('takes more than the old burst of 60 when the operator raises the limit', async () => {
      const running = await stack.boot({
        WEBHOOK_ENDPOINT_BURST_LIMIT: '100',
        WORKSPACE_QUEUED_RUN_LIMIT: '1000',
      });
      try {
        const owner = await newWorkspace(running.origin);
        const { path } = await publishGraph(owner, 'Burst', {
          nodes: [step('webhook', 'core.webhook', 0)],
          edges: [],
        });
        const { endpointKey, signingSecret } = await provisionWebhook(
          owner,
          path,
        );
        const responses = await Promise.all(
          Array.from({ length: 80 }, () =>
            signedDelivery(running.origin, endpointKey, signingSecret),
          ),
        );
        const bodies = await Promise.all(responses.map((r) => r.text()));
        expect(
          new Set(responses.map(({ status }) => status)),
          [
            ...new Set(bodies.filter((_, at) => responses[at]?.status !== 202)),
          ].join('\n'),
        ).toEqual(new Set([202]));
      } finally {
        await running.stop();
      }
    }, 120_000);
  },
);
