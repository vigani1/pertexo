import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  createWebhookScenario,
  webhook,
  owner,
  ownerQuery,
  workerPool,
  workspaceId,
  apiConfig,
} from './webhooks.fixture.js';
import { createWebhookTriggerStore } from '../../../src/triggers/webhooks/webhook-trigger.store.js';
import { WebhookIngressRateLimitExceededError } from '../../../src/triggers/webhooks/webhook-trigger.errors.js';
import { waitForBlockedBy } from '../../support/postgres/lock-coordination.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

describe('database-clock webhook ingress windows', () => {
  it('observes expiry after waiting for the counter lock, then starts exactly one new window', async () => {
    const { resources } = await createWebhookScenario();
    await ownerQuery(
      `insert into app.webhook_endpoint_ingress_limits(endpoint_id,workspace_id,bucket_started_at,request_count)
      values($1,$2,clock_timestamp()-interval '59 seconds',60)`,
      [resources.endpointId, workspaceId],
    );
    const blocker = await owner.connect();
    let consume: Promise<void> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const locked = await blocker.query<{ pid: number }>(
        `select pg_backend_pid() pid from app.webhook_endpoint_ingress_limits where endpoint_id=$1 for update`,
        [resources.endpointId],
      );
      const pid = locked.rows[0]?.pid;
      if (pid === undefined) throw new Error('Counter lock is missing');
      consume = webhook.consumeIngressLimit(resources.endpointKeyHash);
      const settled = consume.catch((error: unknown) => error);
      await waitForBlockedBy(workerPool, pid, { timeout: 5_000 });
      await blocker.query(
        `select pg_sleep(greatest(0,extract(epoch from bucket_started_at+interval '1 minute'-clock_timestamp()))+0.1)
        from app.webhook_endpoint_ingress_limits where endpoint_id=$1`,
        [resources.endpointId],
      );
      await blocker.query('commit');
      expect(await settled).toBeUndefined();
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await consume?.catch(() => undefined);
    }
    expect(
      (
        await ownerQuery(
          `select request_count,extract(epoch from clock_timestamp()-bucket_started_at)::float8 age
      from app.webhook_endpoint_ingress_limits where endpoint_id=$1`,
          [resources.endpointId],
        )
      ).rows[0],
    ).toMatchObject({ request_count: 1, age: expect.any(Number) as unknown });
  });

  it('admits only the burst under concurrent first requests and concurrent resets, with a bounded retry refusal', async () => {
    const { resources } = await createWebhookScenario();
    const limited = createWebhookTriggerStore(apiConfig, undefined, {
      burstLimit: 2,
    });
    try {
      for (let window = 0; window < 2; window++) {
        if (window > 0)
          await ownerQuery(
            `update app.webhook_endpoint_ingress_limits set bucket_started_at=clock_timestamp()-interval '2 minutes'
          where endpoint_id=$1`,
            [resources.endpointId],
          );
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, () =>
            limited.consumeIngressLimit(resources.endpointKeyHash),
          ),
        );
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(2);
        for (const result of results)
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(
              WebhookIngressRateLimitExceededError,
            );
            const error = result.reason as WebhookIngressRateLimitExceededError;
            expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);
          }
        expect(
          (
            await ownerQuery(
              'select request_count from app.webhook_endpoint_ingress_limits where endpoint_id=$1',
              [resources.endpointId],
            )
          ).rows,
        ).toEqual([{ request_count: 2 }]);
      }
    } finally {
      await limited.close();
    }
  });
});
