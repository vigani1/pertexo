import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  createWorkspace,
  graphOf,
  publishWorkflow,
  registerAccount,
  signIn,
  type Browser,
} from './actions.js';
import type { Stack } from './stack.js';

// Quadratic work on a small list: it always outlasts the time limit.
const SLOW = '$distinct([1..50000])';

describe.runIf(betterAuthIntegrationEnabled)(
  'an expression that runs out of time, in a real run',
  () => {
    let stack: Stack;
    let browser: Browser;
    let workspaceId: string;

    beforeAll(async () => {
      const { startStack } = await import('./stack.js');
      stack = await startStack({
        worker: true,
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
      await registerAccount(stack, 'author@integration.test');
      browser = await signIn(stack, 'author@integration.test');
      workspaceId = await createWorkspace(stack, browser);
    }, 300_000);
    afterAll(async () => {
      await stack.close();
    }, 60_000);

    it('tries again and then names the expression, not the inputs', async () => {
      const { path } = await publishWorkflow(
        stack,
        browser,
        workspaceId,
        graphOf([
          { id: 'start', key: 'core.manual' },
          {
            id: 'slow',
            key: 'core.set',
            inputMappings: {
              slow: {
                kind: 'expression',
                language: 'jsonata',
                expression: SLOW,
              },
            },
          },
        ]),
      );
      const started = await stack.send('POST', `${path}/runs`, {
        browser,
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { input: {} },
      });
      const runId = (started.json() as { run: { id: string } }).run.id;

      const finished = await waitForRun(runId);

      expect(finished.run.status).toBe('failed');
      expect(
        finished.nodes.find((node) => node.nodeId === 'slow'),
      ).toMatchObject({ safeErrorCode: 'execution.expression_timed_out' });
      const attempts = await stack.query<{ count: number }>(
        `select count(*)::int as count
           from app.node_attempts as attempt
           join app.node_runs as node on node.id = attempt.node_run_id
          where node.workflow_run_id = $1 and node.node_id = 'slow'`,
        [runId],
      );
      expect(attempts.rows[0]?.count).toBe(3);
    }, 180_000);

    async function waitForRun(runId: string) {
      const finished = ['succeeded', 'failed', 'canceled', 'outcome_unknown'];
      const deadline = Date.now() + 90_000;
      for (;;) {
        const reply = await stack.send(
          'GET',
          `/v1/workspaces/${workspaceId}/runs/${runId}`,
          { browser },
        );
        const body = reply.json() as {
          run: { status: string };
          nodes: { nodeId: string; safeErrorCode: string | null }[];
        };
        if (finished.includes(body.run.status) || Date.now() > deadline)
          return body;
        await delay(250);
      }
    }
  },
);
