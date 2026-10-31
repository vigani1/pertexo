import { waitForBlockedBy } from '../../../support/postgres/lock-coordination.js';
import { webhookRunInput } from '@pertexo/nodes-core';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  workspaceId,
  hash,
  post,
  acceptWebhook,
  webhook,
  owner,
  workerPool,
  ownerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';

export function registerPreparesFreshInputCoordinationReplay(): void {
  it.each([false, true])(
    'prepares fresh input and coordination when a replay expires behind the admission fence (%s)',
    async (coordinated) => {
      const { resources, verification } = await createWebhookScenario(
        coordinated
          ? {
              coordination: {
                mode: 'deduplicate',
                key: { kind: 'run_input', path: '$.orderId' },
                windowSeconds: 60,
              },
            }
          : {},
      );
      const input = {
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ orderId: 'order-42', amount: 19 }),
        ),
        bodyBytes: 34,
        checkpointFactory,
      };
      const first = await webhook.acceptVerifiedDelivery(input);
      if (!('runId' in first)) throw new Error('Expected the initial run');
      const fence = await owner.connect();
      let replacement:
        ReturnType<typeof webhook.acceptVerifiedDelivery> | undefined;
      try {
        await fence.query('begin');
        await fence.query('set local role pertexo_owner');
        await fence.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const held = await fence.query<{ pid: number }>(
          'select pg_backend_pid() pid, id from app.workspaces where id=$1 for update',
          [workspaceId],
        );
        const pid = held.rows[0]?.pid;
        if (pid === undefined) throw new Error('Admission fence missing');
        replacement = webhook.acceptVerifiedDelivery(input);
        // Observe the blocked write: its preliminary read has seen the live receipt.
        await waitForBlockedBy(workerPool, pid, { timeout: 10_000 });
        await fence.query(
          `update app.webhook_trigger_replay_records set created_at=clock_timestamp()-interval '24 hours 2 seconds', expires_at=clock_timestamp()-interval '2 seconds' where workspace_id=$1 and endpoint_id=$2 and dedupe_key_hash=$3`,
          [workspaceId, resources.endpointId, input.idempotencyKeyHash],
        );
        await fence.query('commit');
      } finally {
        await fence.query('rollback');
        fence.release();
      }
      const result = await replacement;
      if (coordinated) {
        expect(result).toMatchObject({
          coordinated: true,
          outcome: 'deduplicated',
        });
      } else {
        expect(result).toMatchObject({ replayed: false });
        if (!('runId' in result)) throw new Error('Expected fresh admission');
        expect(result.runId).not.toBe(first.runId);
        const stored = await ownerQuery<{
          input_ref: { value: unknown } | null;
        }>('select input_ref from app.workflow_runs where id=$1', [
          result.runId,
        ]);
        expect(stored.rows[0]?.input_ref?.value).toEqual({
          orderId: 'order-42',
          amount: 19,
        });
      }
    },
    20_000,
  );

  it('serializes expired replay replacement with database time', async () => {
    const { resources, verification } = await createWebhookScenario();
    const requestFingerprint = hash('expired-keyed-payload');
    const dedupeKeyHash = hash('expired-keyed-key');
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint,
      idempotencyKeyHash: dedupeKeyHash,
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'expired-keyed' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    const first = await acceptWebhook(input);
    const observation = await ownerQuery<{ observed_at: Date }>(
      `update app.webhook_trigger_replay_records
          set created_at=clock_timestamp()-interval '24 hours 2 seconds',
              expires_at=clock_timestamp()-interval '2 seconds'
        where workspace_id=$1 and endpoint_id=$2 and dedupe_key_hash=$3
        returning clock_timestamp() observed_at`,
      [workspaceId, resources.endpointId, dedupeKeyHash],
    );
    expect(observation.rows[0]?.observed_at).toBeInstanceOf(Date);

    const raced = await Promise.all([
      acceptWebhook(input),
      acceptWebhook(input),
    ]);
    expect(new Set(raced.map(({ runId }) => runId)).size).toBe(1);
    expect(raced[0].runId).not.toBe(first.runId);
    expect(raced.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    // Admits twice; the race also records its losing exact replay.
    await expect(
      ownerQuery<{ outcome: string; count: number }>(
        `select outcome,count(*)::int count from app.webhook_trigger_deliveries
          where workspace_id=$1 and endpoint_id=$2
          group by outcome order by outcome`,
        [workspaceId, resources.endpointId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { outcome: 'accepted', count: 2 },
        { outcome: 'replayed', count: 1 },
      ],
    });
  });

  it('rolls back replay, run, delivery, and outbox after post-replay failure', async () => {
    const { resources, verification } = await createWebhookScenario();
    const durableCounts = () =>
      ownerQuery<{
        deliveries: number;
        outbox_events: number;
        replay_records: number;
        runs: number;
      }>(
        `select
          (select count(*)::int from app.webhook_trigger_deliveries
            where workspace_id=$1 and endpoint_id=$2) deliveries,
          (select count(*)::int from app.webhook_trigger_replay_records
            where workspace_id=$1 and endpoint_id=$2) replay_records,
          (select count(*)::int from app.workflow_runs
            where workspace_id=$1 and workflow_id=$3) runs,
          (select count(*)::int from app.outbox_events
            where workspace_id=$1 and aggregate_type='workflow_run'
              and aggregate_id in (select id from app.workflow_runs
                where workspace_id=$1 and workflow_id=$3)) outbox_events`,
        [workspaceId, resources.endpointId, verification.workflowId],
      ).then((result) => result.rows[0]);
    const before = await durableCounts();
    const failure = new Error('checkpoint construction failed after replay');
    await expect(
      acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('post-replay-rollback'),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ event: 'post-replay-rollback' }),
        ),
        bodyBytes: 64,
        checkpointFactory: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await expect(durableCounts()).resolves.toEqual(before);
  });
}
