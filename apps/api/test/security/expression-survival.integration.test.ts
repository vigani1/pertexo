import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  registerAccount,
  signIn,
  createWorkspace,
  publishWorkflow,
  graphOf,
  openSecretUrlEndpoint,
  type Browser,
} from './actions.js';
import type { Stack } from './stack.js';

const HOSTILE = '$join([1..10000000],",")';
const DELIVERIES = 3;

/** One delivery's answer; a dead API shows up as a refused connection. */
async function deliver(stack: Stack, path: string) {
  try {
    const reply = await stack.send('POST', path, {
      withoutOrigin: true,
      body: { order: 'first' },
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    return { status: reply.status, body: reply.text };
  } catch {
    return { status: 0, body: 'connection failed' };
  }
}

describe.runIf(betterAuthIntegrationEnabled)(
  'an expression against the real API and worker processes',
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

    // sec-01: one delivery with a hostile coordination key killed the API.
    it.fails(
      'refuses the delivery with a clear error and the API keeps serving',
      async () => {
        const { path } = await publishWorkflow(
          stack,
          browser,
          workspaceId,
          graphOf([
            {
              id: 'hook',
              key: 'core.webhook',
              config: {
                coordination: {
                  mode: 'deduplicate',
                  key: {
                    kind: 'expression',
                    language: 'jsonata',
                    expression: HOSTILE,
                  },
                },
              },
            },
          ]),
        );
        const endpoint = await openSecretUrlEndpoint(stack, browser, path);

        const replies = [];
        for (let delivery = 0; delivery < DELIVERIES; delivery++)
          replies.push(await deliver(stack, endpoint));
        expect(stack.api.alive, stack.api.describeExit()).toBe(true);
        for (const reply of replies) {
          // The sender got past authentication, so the key really was evaluated.
          expect(reply.status, reply.body).not.toBe(401);
          expect(JSON.parse(reply.body)).toEqual(
            // The ingress contract's refusal, or a problem naming what went wrong.
            reply.status === 202
              ? expect.objectContaining({
                  status: 'refused',
                  reason: expect.stringMatching(/^[a-z_]+$/u) as string,
                })
              : expect.objectContaining({
                  code: expect.stringMatching(/^[a-z_.]+$/u) as string,
                }),
          );
          expect(reply.body).not.toMatch(/heap|jsonata|node:internal/iu);
        }
        const health = await stack.send('GET', '/health/ready');
        expect(health.status).toBe(200);
        const someoneElse = await stack.send('GET', '/v1/users/me', {
          browser,
        });
        expect(someoneElse.status).toBe(200);
      },
      120_000,
    );

    // sec-01: the same expression in a step killed the worker once per run.
    it.fails(
      'fails the step with a clear error and the worker runs the next one',
      async () => {
        const hostile = await publishWorkflow(
          stack,
          browser,
          workspaceId,
          graphOf([
            { id: 'start', key: 'core.manual' },
            {
              id: 'bomb',
              key: 'core.set',
              inputMappings: {
                bomb: {
                  kind: 'expression',
                  language: 'jsonata',
                  expression: HOSTILE,
                },
              },
            },
          ]),
        );
        const healthy = await publishWorkflow(
          stack,
          browser,
          workspaceId,
          graphOf([
            { id: 'start', key: 'core.manual' },
            {
              id: 'fine',
              key: 'core.set',
              inputMappings: { ok: { kind: 'literal', value: true } },
            },
          ]),
        );

        const hostileRun = await startRun(hostile.path);
        const failed = await waitForRun(hostileRun);
        expect(stack.worker?.alive, stack.worker?.describeExit()).toBe(true);
        expect(failed.run.status).toBe('failed');
        // The person reading the run learns it was their expression, not "invalid".
        expect(
          failed.nodes.find((node) => node.nodeId === 'bomb')?.safeErrorCode,
        ).toMatch(/expression/u);
        expect(JSON.stringify(failed)).not.toMatch(
          /heap out of memory|node:internal/iu,
        );

        const healthyRun = await startRun(healthy.path);
        expect((await waitForRun(healthyRun)).run.status).toBe('succeeded');
        expect(stack.worker?.alive, stack.worker?.describeExit()).toBe(true);
      },
      180_000,
    );

    async function startRun(workflowPath: string): Promise<string> {
      const started = await stack.send('POST', `${workflowPath}/runs`, {
        browser,
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { input: {} },
      });
      if (started.status !== 202 && started.status !== 201)
        throw new Error(`Run: ${String(started.status)} ${started.text}`);
      return (started.json() as { run: { id: string } }).run.id;
    }

    async function waitForRun(runId: string) {
      const finished = ['succeeded', 'failed', 'canceled', 'outcome_unknown'];
      const deadline = Date.now() + 60_000;
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
