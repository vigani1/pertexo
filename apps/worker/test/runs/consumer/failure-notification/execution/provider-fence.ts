import { performance } from 'node:perf_hooks';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';

import { expect } from 'vitest';
import { createProviderFailureNotificationDelivery } from '../../../../../src/notifications/failure-delivery.js';

import { workerQuery, workspaceId } from '../fixture.js';
import type {
  FailureNotificationScenario,
  FailureProofStore,
} from './contract.js';

export async function assertProviderFenceDrain(
  scenario: FailureNotificationScenario,
  store: FailureProofStore,
) {
  const { slackConnectionId, intentId, slackIntentId } = scenario;
  const retryOutboxes = await workerQuery<{
    aggregate_id: string;
    id: string;
    payload_checksum: string;
  }>(
    `select distinct on (aggregate_id) aggregate_id,id,payload_checksum
             from app.outbox_events
            where workspace_id=$1 and aggregate_id=any($2::uuid[])
            order by aggregate_id,created_at desc,id desc`,
    [workspaceId, [intentId, slackIntentId]],
  );
  const blockedClaims = await Promise.all(
    retryOutboxes.map(async (outbox) => ({
      intentId: outbox.aggregate_id,
      claim: await store.claimDelivery({
        workspaceId,
        intentId: outbox.aggregate_id,
        delivery: {
          outboxEventId: outbox.id,
          payloadChecksum: outbox.payload_checksum,
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      }),
    })),
  );
  expect(blockedClaims).toHaveLength(2);
  if (blockedClaims.some(({ claim }) => claim.kind !== 'ready'))
    throw new Error('blocked destination claims were not ready');

  const blockedProviderCalls: string[] = [];
  let enteredCount = 0;
  let resolveEntered: (() => void) | undefined;
  let rejectEntered: ((error: Error) => void) | undefined;
  let enteredDeadline: ReturnType<typeof setTimeout> | undefined;
  const allEntered = new Promise<void>((resolve, reject) => {
    resolveEntered = resolve;
    rejectEntered = reject;
    enteredDeadline = setTimeout(() => {
      reject(new Error('Provider drain barrier timed out'));
    }, 5_000);
  });
  const blockAfterFence = async (
    provider: 'email' | 'slack',
    signal: AbortSignal,
  ): Promise<never> => {
    blockedProviderCalls.push(provider);
    enteredCount += 1;
    if (enteredCount === 2) resolveEntered?.();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
    });
    throw new SecureHttpError(SECURE_HTTP_ERROR_CODE.canceled, 'ambiguous', {
      possiblyDispatched: true,
    });
  };
  const blockedDelivery = createProviderFailureNotificationDelivery({
    store,
    encryption: {
      open: (_sealed, encryptionContext) =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(
              encryptionContext.connectionId === slackConnectionId
                ? {
                    type: 'slack_bot_token',
                    botToken: 'xoxb-integration-only',
                  }
                : {
                    type: 'resend_api_key',
                    apiKey: 're_integration_only',
                    fromEmail: 'sender@example.test',
                  },
            ),
          ),
        ),
    },
    slack: {
      sendMessage: async (input) => {
        await input.beforeDispatch();
        return blockAfterFence('slack', input.signal);
      },
    },
    email: {
      sendNotification: async (input) => {
        await input.beforeDispatch();
        expect(input.idempotencyKey).toBe(`failure-notification:${intentId}`);
        if (input.signal === undefined)
          throw new Error('blocked email dispatch signal missing');
        return blockAfterFence('email', input.signal);
      },
    },
    workerId: 'failure-notification-drain-worker',
  });
  const blockedControllers = blockedClaims.map(() => new AbortController());
  const blockedResults = blockedClaims.map(
    ({ claim, intentId: claimedId }, index) => {
      if (claim.kind !== 'ready') throw new Error('blocked claim changed kind');
      const controller = blockedControllers[index];
      if (controller === undefined)
        throw new Error('blocked controller missing');
      return blockedDelivery.deliver({
        context: claim.context,
        workspaceId,
        intentId: claimedId,
        attemptNumber: claim.attemptNumber,
        destinationId: claim.destinationId,
        destinationConfigVersion: claim.destinationConfigVersion,
        idempotencyKey: claim.idempotencyKey,
        sideEffectClass: claim.sideEffectClass,
        connectionSecretVersionId: claim.connectionSecretVersionId,
        deliveryUnresolved: claim.deliveryUnresolved,
        ...(claim.deliveryBinding === undefined
          ? {}
          : { deliveryBinding: claim.deliveryBinding }),
        signal: controller.signal,
      });
    },
  );
  try {
    await allEntered;
  } catch (barrierError: unknown) {
    for (const controller of blockedControllers) controller.abort();
    const settlements = await Promise.allSettled(blockedResults);
    const drainErrors = settlements.flatMap((settlement) =>
      settlement.status === 'rejected' ? [settlement.reason as unknown] : [],
    );
    if (drainErrors.length === 0) throw barrierError;
    throw new AggregateError(
      [barrierError, ...drainErrors],
      'Provider drain barrier and blocked deliveries failed',
    );
  } finally {
    if (enteredDeadline !== undefined) clearTimeout(enteredDeadline);
    // Ensure the deferred cannot remain pending if setup fails before both
    // provider callbacks enter. Rejection after settlement is inert.
    rejectEntered?.(new Error('Provider drain barrier disposed'));
  }
  const drainStartedAt = performance.now();
  for (const controller of blockedControllers) controller.abort();
  const settledBlockedResults = await Promise.all(blockedResults);
  expect(performance.now() - drainStartedAt).toBeLessThan(2_000);
  expect(blockedProviderCalls.sort()).toEqual(['email', 'slack']);

  for (const [index, blocked] of blockedClaims.entries()) {
    const result = settledBlockedResults[index];
    if (blocked.claim.kind !== 'ready' || result === undefined)
      throw new Error('blocked result identity missing');
    await expect(
      store.completeDelivery({
        workspaceId,
        intentId: blocked.intentId,
        attemptNumber: blocked.claim.attemptNumber,
        maxAttempts: 3,
        retryDelaySeconds: result.kind === 'retry' ? 1 : 0,
        result,
      }),
    ).resolves.toBe('completed');
  }
  const postDrain = await workerQuery<{
    delivery_binding: string | null;
    id: string;
    possibly_dispatched: boolean;
    status: string;
  }>(
    `select id,status,possibly_dispatched,delivery_binding
             from app.run_failure_notification_intents
            where workspace_id=$1 and id=any($2::uuid[])`,
    [workspaceId, [intentId, slackIntentId]],
  );
  expect(postDrain.find((row) => row.id === slackIntentId)).toMatchObject({
    status: 'outcome_unknown',
    possibly_dispatched: true,
  });
  const drainedEmail = postDrain.find((row) => row.id === intentId);
  expect(drainedEmail).toMatchObject({
    status: 'retry',
    possibly_dispatched: true,
  });
  expect(drainedEmail?.delivery_binding).toMatch(/^email:sha256:/u);
}
