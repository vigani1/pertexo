import { webhookRunInput } from '@pertexo/nodes-core';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { WebhookTriggerNotFoundError } from '../../../../src/triggers/webhooks/errors.js';

import type { WebhookDeliveryPosition } from '../../../../src/triggers/webhooks/contract.js';

import {
  actorId,
  workspaceId,
  workflowId,
  hash,
  post,
  acceptWebhook,
  webhook,
  readinessPool,
  ownerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';

export function registerRecordsMetadataDeliveryOutcomesPages(): void {
  it('records metadata-only delivery outcomes and pages the retained log', async () => {
    const { published, resources, verification } =
      await createWebhookScenario();
    const admitted = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('delivery-log-payload'),
      idempotencyKeyHash: hash('delivery-log-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'delivery-log' }),
      ),
      bodyBytes: 321,
      checkpointFactory,
    } as const;
    const accepted = await acceptWebhook(admitted);
    await expect(acceptWebhook(admitted)).resolves.toEqual({
      runId: accepted.runId,
      replayed: true,
    });
    const endpoint = {
      workspaceId,
      triggerId: resources.webhookId,
      endpointId: resources.endpointId,
    };
    const rejections = [
      ['authentication_failed', 'not_checked', 'stale_timestamp'],
      ['authentication_failed', 'mismatch', 'not_checked'],
      ['invalid_request', 'verified', 'not_checked'],
      ['conflict', 'verified', 'conflict'],
      ['rate_limited', 'verified', 'new'],
    ] as const;
    for (const [index, [outcome, signatureCheck, replayCheck]] of [
      ...rejections.entries(),
    ])
      await webhook.recordRejectedDelivery({
        endpoint,
        outcome,
        signatureCheck,
        replayCheck,
        bodyBytes: index,
      });
    await expect(
      webhook.recordRejectedDelivery({
        endpoint,
        outcome: 'conflict',
        signatureCheck: 'mismatch',
        replayCheck: 'new',
        bodyBytes: 1,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: 'webhook_trigger_deliveries_outcome_valid' },
    });

    const read = {
      workspaceId,
      actorId,
      workflowId: published.created.workflowId,
      triggerId: resources.webhookId,
      limit: 3,
    };
    const nextPage = (cursor: WebhookDeliveryPosition | undefined) => {
      if (cursor === undefined) throw new Error('Expected another page');
      return webhook.listDeliveries({ ...read, after: cursor });
    };
    const first = await webhook.listDeliveries(read);
    const second = await nextPage(first.nextCursor);
    const third = await nextPage(second.nextCursor);
    expect(
      [first, second, third].map((page) =>
        page.items.map(({ outcome, httpStatus, bodyBytes }) => [
          outcome,
          httpStatus,
          bodyBytes,
        ]),
      ),
    ).toEqual([
      [
        ['rate_limited', 429, 4],
        ['conflict', 409, 3],
        ['invalid_request', 400, 2],
      ],
      [
        ['authentication_failed', 401, 1],
        ['authentication_failed', 401, 0],
        ['replayed', 202, 321],
      ],
      [['accepted', 202, 321]],
    ]);
    expect(third.nextCursor).toBeUndefined();
    expect(second.items[2]).toMatchObject({
      signatureCheck: 'verified',
      replayCheck: 'duplicate',
      runId: accepted.runId,
    });
    expect(third.items[0]).toMatchObject({
      signatureCheck: 'verified',
      replayCheck: 'new',
      runId: accepted.runId,
    });
    expect(first.items.every(({ runId }) => runId === null)).toBe(true);
    const columns = await ownerQuery<{ keys: string[] }>(
      `select array_agg(key order by key) keys from (
         select distinct jsonb_object_keys(to_jsonb(delivery)) key
           from app.webhook_trigger_deliveries delivery
          where workspace_id=$1 and endpoint_id=$2) keys`,
      [workspaceId, resources.endpointId],
    );
    expect(columns.rows[0]?.keys).toEqual([
      'body_bytes',
      'coordination_event_id',
      'endpoint_id',
      'expires_at',
      'http_status',
      'id',
      'outcome',
      'received_at',
      'replay_check',
      'signature_check',
      'skip_reason',
      'workflow_run_id',
      'workspace_id',
    ]);

    await ownerQuery(
      `update app.webhook_trigger_deliveries
          set received_at=clock_timestamp()-interval '91 days',
              expires_at=clock_timestamp()-interval '1 day'
        where workspace_id=$1 and endpoint_id=$2 and outcome='rate_limited'`,
      [workspaceId, resources.endpointId],
    );
    const retained = await webhook.listDeliveries({ ...read, limit: 100 });
    expect(retained.items.map(({ outcome }) => outcome)).not.toContain(
      'rate_limited',
    );
    expect(retained.items).toHaveLength(6);

    for (const hidden of [
      { ...read, actorId: randomUUID() },
      { ...read, triggerId: resources.scheduleId },
      { ...read, workflowId: workflowId },
      { ...read, workspaceId: randomUUID() },
    ])
      await expect(webhook.listDeliveries(hidden)).rejects.toBeInstanceOf(
        WebhookTriggerNotFoundError,
      );
    const otherTenant = await readinessPool.connect();
    try {
      await otherTenant.query('begin');
      await otherTenant.query("select set_config('app.workspace_id',$1,true)", [
        randomUUID(),
      ]);
      await expect(
        otherTenant.query(
          'select id from app.webhook_trigger_deliveries where endpoint_id=$1',
          [resources.endpointId],
        ),
      ).resolves.toMatchObject({ rows: [] });
      await otherTenant.query('rollback');
    } finally {
      otherTenant.release();
    }
  });

  it.each([
    [{}, { orderId: 'A-1' }],
    [
      { runInput: 'request' },
      {
        method: 'POST',
        body: { orderId: 'A-1' },
        query: { source: 'shop' },
        headers: { 'x-shop-event': 'order.paid' },
      },
    ],
  ])(
    'starts the run with the input its trigger asks for %#',
    async (config, expected) => {
      const { verification } = await createWebhookScenario(config);
      const { runId } = await acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        runInput: webhookRunInput(verification.runInputMode, {
          method: 'POST',
          body: { orderId: 'A-1' },
          query: { source: 'shop' },
          headers: { 'x-shop-event': 'order.paid' },
        }),
        bodyBytes: 17,
        checkpointFactory,
      });
      const stored = await ownerQuery<{ input_ref: { value: unknown } }>(
        'select input_ref from app.workflow_runs where id=$1',
        [runId],
      );
      expect(stored.rows[0]?.input_ref.value).toEqual(expected);
    },
  );
}
