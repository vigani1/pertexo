import { webhookRunInput } from '@pertexo/nodes-core';
import { createTriggerEventScanner } from '../../../../src/triggers/coordination/scanner.repository.js';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  hash,
  secret,
  apiConfig,
  post,
  webhook,
  ownerQuery,
  workerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';

export function registerSaysWebhookAlreadyHasEndpoint(): void {
  it('says a webhook that already has an endpoint can’t take another', async () => {
    const { verification } = await createWebhookScenario();
    await expect(
      webhook.provision({
        workspaceId,
        workflowId: verification.workflowId,
        actorId,
        triggerId: verification.triggerId,
        endpointId: randomUUID(),
        endpointKeyHash: hash(`endpoint-${randomUUID()}`),
        secret: secret(),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toMatchObject({
      name: 'WebhookTriggerStateError',
      reason: 'provisioned',
    });
  });

  it.each(['deduplicate', 'debounce', 'throttle'] as const)(
    'coordinates verified %s deliveries before ordinary run admission',
    async (mode) => {
      const scenario = await createWebhookScenario({
        coordination: {
          mode,
          key: { kind: 'run_input', path: '$.orderId' },
          ...(mode === 'debounce'
            ? { quietSeconds: 1 }
            : { windowSeconds: 60 }),
          ...(mode === 'throttle' ? { limit: 1, onExcess: 'delay' } : {}),
        },
      });
      const verification = scenario.verification;
      const input = {
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ orderId: 'order-42' }),
        ),
        bodyBytes: 22,
        checkpointFactory,
      };
      const first = await webhook.acceptVerifiedDelivery(input);
      const replay = await webhook.acceptVerifiedDelivery(input);
      expect(replay).toEqual(
        'runId' in first ? { ...first, replayed: true } : first,
      );
      const second = await webhook.acceptVerifiedDelivery({
        ...input,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
      });
      let coordinationOutcome;
      if (mode === 'deduplicate') {
        coordinationOutcome = 'deduplicated';
      } else {
        if (mode === 'debounce') {
          coordinationOutcome = 'debounced';
        } else {
          coordinationOutcome = 'throttled';
        }
      }
      expect(second).toMatchObject({
        coordinated: true,
        outcome: coordinationOutcome,
      });
      const history = await webhook.listDeliveries({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        triggerId: verification.triggerId,
      });
      expect(history.items).toHaveLength(3);
      expect(
        history.items.every((item) => item.coordination !== undefined),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'releases a pending webhook with response context or refuses its disabled endpoint (%s)',
    async (disable) => {
      const scenario = await createWebhookScenario({
        responseMode: 'workflow',
        responseWaitSeconds: 1,
        coordination: {
          mode: 'debounce',
          key: { kind: 'run_input', path: '$.orderId' },
          quietSeconds: 3600,
        },
      });
      const verification = scenario.verification;
      const input = {
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ orderId: 'order-42' }),
        ),
        bodyBytes: 22,
        checkpointFactory,
      };
      const receipt = await webhook.acceptVerifiedDelivery(input);
      if (!('coordinated' in receipt))
        throw new Error('Expected deferred webhook');
      await ownerQuery(
        "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '1 second' where id=$1",
        [receipt.eventId],
      );
      expect(
        (
          await ownerQuery(
            'select status,endpoint_id from app.trigger_coordinated_events where id=$1',
            [receipt.eventId],
          )
        ).rows,
      ).toEqual([{ status: 'pending', endpoint_id: verification.endpointId }]);
      if (disable)
        expect(
          (
            await workerQuery(
              "update app.webhook_trigger_endpoints set status='disabled' where id=$1 returning status",
              [verification.endpointId],
            )
          ).rows,
        ).toEqual([{ status: 'disabled' }]);
      const scanner = createTriggerEventScanner(apiConfig);
      try {
        await scanner.scanDue({ limit: 100, checkpointFactory });
      } finally {
        await scanner.close();
      }
      const event = (
        await ownerQuery<{
          status: string;
          reason: string | null;
          run_id: string | null;
          input_ref: unknown;
        }>(
          'select status,reason,run_id,input_ref from app.trigger_coordinated_events where id=$1',
          [receipt.eventId],
        )
      ).rows[0];
      expect(event).toMatchObject({
        status: disable ? 'refused' : 'started',
        reason: disable ? 'endpoint_disabled' : null,
        input_ref: null,
      });
      if (!disable) {
        if (event?.run_id === null || event?.run_id === undefined)
          throw new Error('Missing admitted run');
        expect(
          await webhook.readResponse({ workspaceId, runId: event.run_id }),
        ).toEqual({ state: 'pending' });
        expect(await webhook.acceptVerifiedDelivery(input)).toEqual(receipt);
      }
    },
  );
}
