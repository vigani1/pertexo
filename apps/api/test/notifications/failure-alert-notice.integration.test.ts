import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  ownWorkspace,
  publishGraph,
  runReaches,
  signUp,
  startRun,
  step,
  type StackOwner,
} from '../support/real-stack/owner.js';
import { createRealStack } from '../support/real-stack/stack.js';

// Attempts at 0, 30 and 60 seconds, then the observer's next walk.
const UNDELIVERED_WITHIN_MILLIS = 150_000;

/** A step that always fails: this address is private, so the worker refuses to call it. */
const failingGraph = () => {
  const nodes = [
    step('manual', 'core.manual', 0),
    step('work', 'http.request', 200, {
      method: 'GET',
      url: 'http://127.0.0.1:9/never',
      headers: {},
      timeoutMillis: 5_000,
      maxRedirects: 0,
      maxResponseBytes: 4096,
      inlineResponseBytes: 4096,
    }),
  ];
  return {
    nodes,
    edges: [
      {
        id: 'edge-0',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'work', port: 'in' },
      },
    ],
  };
};

async function created<T>(response: Response): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBeLessThan(300);
  return (body === '' ? undefined : JSON.parse(body)) as T;
}

describe.skipIf(!betterAuthIntegrationEnabled)(
  'an alert that cannot be delivered, on real API and worker processes',
  () => {
    const stack = createRealStack('failure-alerts');

    beforeAll(() => stack.create(), 120_000);
    afterAll(() => stack.close(), 60_000);

    async function notices(owner: StackOwner) {
      const listed = await owner.send(
        'GET',
        `${owner.base}/notifications?noticeKind=failure_alert_attention`,
      );
      expect(listed.status).toBe(200);
      return ((await listed.json()) as { items: Record<string, unknown>[] })
        .items;
    }

    it('shows one notice in the Inbox API after real runs fail, and clears it when the destination is edited', async () => {
      const { origin, stop } = await stack.boot();
      try {
        const owner = await ownWorkspace(await signUp(stack, origin));
        const { path, workflowId } = await publishGraph(
          owner,
          'Nightly import',
          failingGraph(),
        );
        const connection = await created<{ id: string }>(
          await owner.send('POST', `${owner.base}/connections`, {
            providerKey: 'slack',
            name: 'Team Slack',
            credential: {
              type: 'slack_bot_token',
              botToken: 'xoxb-not-a-real-token',
            },
          }),
        );
        const destination = await created<{ id: string }>(
          await owner.send(
            'POST',
            `${owner.base}/failure-notification-destinations`,
            {
              kind: 'slack',
              connectionId: connection.id,
              channelId: 'C0123456789',
            },
          ),
        );
        await created(
          await owner.send(
            'PUT',
            `${owner.base}/workflows/${workflowId}/failure-notification-policy`,
            { destinationId: destination.id },
          ),
        );
        // The credential no longer opens, so the alert fails without leaving this machine.
        await stack.queryAsOwner(
          `update app.connection_secret_versions
                set auth_tag='AAAAAAAAAAAAAAAAAAAAAA'
              where connection_id=$1`,
          [connection.id],
        );

        const runs = [await startRun(owner, path), await startRun(owner, path)];
        for (const run of runs) await runReaches(owner, run, 'failed');
        // Both alerts are still being retried, and may yet arrive.
        expect(await notices(owner)).toEqual([]);

        await expect
          .poll(() => notices(owner), {
            timeout: UNDELIVERED_WITHIN_MILLIS,
            interval: 1_000,
          })
          .not.toEqual([]);
        const { rows } = await stack.queryAsOwner(
          `select status from app.run_failure_notification_intents
              where destination_id=$1`,
          [destination.id],
        );
        expect(rows.map(({ status }) => status as string)).toContain(
          'dead_letter',
        );
        expect(await notices(owner)).toEqual([
          expect.objectContaining({
            noticeKind: 'failure_alert_attention',
            name: 'Slack',
            subjectId: destination.id,
            workflowId: null,
            occurrenceCount: 1,
            unread: true,
          }),
        ]);

        await created(
          await owner.send(
            'POST',
            `${owner.base}/failure-notification-destinations/${destination.id}/versions`,
            {
              expectedVersion: 1,
              config: {
                kind: 'slack',
                connectionId: connection.id,
                channelId: 'C9876543210',
              },
            },
          ),
        );
        await expect
          .poll(() => notices(owner), { timeout: 30_000, interval: 500 })
          .toEqual([]);
      } finally {
        await stop();
      }
    }, 300_000);
  },
);
