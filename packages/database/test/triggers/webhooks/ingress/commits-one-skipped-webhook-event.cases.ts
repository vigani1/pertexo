import { webhookRunInput } from '@pertexo/nodes-core';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { WebhookDeliveryReplayMismatchError } from '../../../../src/triggers/webhooks/repository.js';

import {
  actorId,
  workspaceId,
  notificationSecretVersionId,
  notificationDestinationId,
  hash,
  post,
  acceptWebhook,
  webhook,
  ownerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';

export function registerCommitsOneSkippedWebhookEvent(): void {
  it('commits one skipped webhook event, preserves its receipt after release and exposes the reason', async () => {
    const { verification } = await createWebhookScenario({
      responseMode: 'workflow',
      responseWaitSeconds: 1,
    });
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('skip-payload'),
      idempotencyKeyHash: hash('skip-first'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ private: 'not in skip metadata' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    };
    const first = await acceptWebhook(input);
    await ownerQuery(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
      [workspaceId, verification.workflowId],
    );
    const skippedInput = { ...input, idempotencyKeyHash: hash('skip-busy') };
    const skipped = { skipped: true, reason: 'concurrency_limit' };
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          webhook.acceptVerifiedDelivery(skippedInput),
        ),
      ),
    ).toEqual([skipped, skipped, skipped, skipped]);
    const counts = () =>
      ownerQuery(
        `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,
      (select count(*)::int from app.usage_events where resource_id=$1 and category='trigger.skipped') skips,
      (select count(*)::int from app.idempotency_records where status='in_progress') incomplete`,
        [verification.workflowId],
      );
    expect((await counts()).rows).toEqual([
      { runs: 1, skips: 1, incomplete: 0 },
    ]);
    const history = await webhook.listDeliveries({
      workspaceId,
      actorId,
      workflowId: verification.workflowId,
      triggerId: verification.triggerId,
    });
    expect(
      history.items.filter((item) => item.outcome === 'skipped'),
    ).toHaveLength(4);
    expect(
      history.items
        .filter((item) => item.outcome === 'skipped')
        .every(
          (item) =>
            item.skipReason === 'concurrency_limit' &&
            item.runId === null &&
            item.httpStatus === 202,
        ),
    ).toBe(true);
    await ownerQuery(
      `update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1`,
      [first.runId],
    );
    expect(await webhook.acceptVerifiedDelivery(skippedInput)).toEqual(skipped);
    await expect(
      webhook.acceptVerifiedDelivery({
        ...skippedInput,
        requestFingerprint: hash('changed'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryReplayMismatchError);
    await acceptWebhook({ ...input, idempotencyKeyHash: hash('skip-next') });
    expect((await counts()).rows).toEqual([
      { runs: 2, skips: 1, incomplete: 0 },
    ]);
    const metadata = await ownerQuery(
      `select metadata from app.usage_events where resource_id=$1 and category='trigger.skipped'`,
      [verification.workflowId],
    );
    expect(metadata.rows).toEqual([
      { metadata: { reason: 'concurrency_limit', triggerType: 'webhook' } },
    ]);
  });

  it('captures opt-in response policy atomically and preserves it for exact ingress retries', async () => {
    const scenario = await createWebhookScenario({
      responseMode: 'workflow',
      responseWaitSeconds: 1,
    });
    const verification = scenario.verification;
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('response-policy'),
      idempotencyKeyHash: hash(randomUUID()),
      runInput: webhookRunInput(verification.runInputMode, post({})),
      bodyBytes: 2,
      checkpointFactory,
    };
    const first = await acceptWebhook(input);
    expect(first).toMatchObject({ replayed: false, responseWaitSeconds: 1 });
    expect(
      await webhook.readResponse({ workspaceId, runId: first.runId }),
    ).toEqual({ state: 'pending' });
    const duplicate = await acceptWebhook(input);
    expect(duplicate).toEqual({ ...first, replayed: true });
    expect(
      (
        await ownerQuery(
          'select run_id,wait_seconds,body from app.webhook_run_responses where run_id=$1',
          [first.runId],
        )
      ).rows,
    ).toEqual([{ run_id: first.runId, wait_seconds: 1, body: null }]);
    const immediate = await createWebhookScenario();
    const accepted = await acceptWebhook({
      ...input,
      verification: immediate.verification,
      verifiedSecretVersionId: immediate.verification.currentSecret.id,
      idempotencyKeyHash: hash(randomUUID()),
    });
    expect(accepted.responseWaitSeconds).toBeUndefined();
    expect(
      (
        await ownerQuery(
          'select run_id from app.webhook_run_responses where run_id=$1',
          [accepted.runId],
        )
      ).rows,
    ).toEqual([]);
  });

  it('resolves eligible sealed references and atomically deduplicates concurrent delivery', async () => {
    const { resources, verification } = await createWebhookScenario();
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('payload-one'),
      idempotencyKeyHash: hash('sender-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'one' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    const accepted = await Promise.all([
      acceptWebhook(input),
      acceptWebhook(input),
    ]);
    expect(new Set(accepted.map(({ runId }) => runId)).size).toBe(1);
    expect(accepted.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    const pins = await ownerQuery(
      `select failure_notification_destination_id,
              failure_notification_destination_config_version,
              failure_notification_side_effect_class,
              failure_notification_connection_secret_version_id
         from app.workflow_runs where id=$1`,
      [accepted[0].runId],
    );
    expect(pins.rows).toEqual([
      {
        failure_notification_destination_id: notificationDestinationId,
        failure_notification_destination_config_version: 1,
        failure_notification_side_effect_class: 'idempotent_with_key',
        failure_notification_connection_secret_version_id:
          notificationSecretVersionId,
      },
    ]);
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('changed-payload'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryReplayMismatchError);
    const retention = await ownerQuery<{
      delivery_seconds: number;
      replay_seconds: number;
    }>(
      `select extract(epoch from delivery.expires_at-delivery.received_at)::integer delivery_seconds,
              extract(epoch from replay.expires_at-replay.created_at)::integer replay_seconds
         from app.webhook_trigger_deliveries delivery
         join app.webhook_trigger_replay_records replay on replay.delivery_id=delivery.id
        where delivery.endpoint_id=$1`,
      [resources.endpointId],
    );
    expect(retention.rows[0]).toEqual({
      delivery_seconds: 90 * 24 * 60 * 60,
      replay_seconds: 24 * 60 * 60,
    });
  });
}
