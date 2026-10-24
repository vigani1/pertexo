import { webhookRunInput } from '@pertexo/nodes-core';

import { expect, it } from 'vitest';

import {
  WebhookDeliveryIneligibleError,
  WebhookTriggerNotFoundError,
} from '../../../../src/triggers/webhooks/repository.js';

import {
  actorId,
  workspaceId,
  hash,
  secret,
  post,
  acceptWebhook,
  webhook,
  ownerQuery,
  apiQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';

export function registerInvalidatesOldEndpointReferencesAt(): void {
  it('invalidates old endpoint references at rotation commit and bounds prior secrets', async () => {
    const {
      published,
      resources,
      verification: oldVerification,
    } = await createWebhookScenario();
    const scenarioWorkflowId = published.created.workflowId;
    const nextEndpointHash = hash('endpoint-two');
    const acceptedBeforeRotation = {
      verification: oldVerification,
      verifiedSecretVersionId: oldVerification.currentSecret.id,
      requestFingerprint: hash('accepted-before-rotation'),
      idempotencyKeyHash: hash('accepted-before-rotation-key'),
      runInput: webhookRunInput(
        oldVerification.runInputMode,
        post({ event: 'accepted-before-rotation' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    await acceptWebhook(acceptedBeforeRotation);
    await webhook.rotateEndpoint({
      workspaceId,
      workflowId: scenarioWorkflowId,
      actorId,
      triggerId: resources.webhookId,
      endpointKeyHash: nextEndpointHash,
      idempotencyKey: 'rotate-endpoint',
      requestHash: hash('rotate-endpoint'),
    });
    await expect(
      webhook.resolveVerification(resources.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(acceptWebhook(acceptedBeforeRotation)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    await expect(
      acceptWebhook({
        ...acceptedBeforeRotation,
        requestFingerprint: hash('changed-after-rotation'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
    await expect(
      acceptWebhook({
        verification: oldVerification,
        verifiedSecretVersionId: oldVerification.currentSecret.id,
        requestFingerprint: hash('rotation-race'),
        runInput: webhookRunInput(
          oldVerification.runInputMode,
          post({ event: 'rotation-race' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);

    const beforeSecretRotation =
      await webhook.resolveVerification(nextEndpointHash);
    if (beforeSecretRotation === null)
      throw new Error('Expected rotated endpoint');
    const nextSecret = secret();
    const beforeWrongKey = await ownerQuery(
      `select endpoint.current_secret_version_id,
              (select count(*)::integer from app.webhook_trigger_secret_versions
                where trigger_id=$1) secret_count
         from app.webhook_trigger_endpoints endpoint where endpoint.trigger_id=$1`,
      [resources.webhookId],
    );
    await expect(
      webhook.rotateSecret({
        workspaceId,
        workflowId: scenarioWorkflowId,
        actorId,
        triggerId: resources.webhookId,
        endpointKeyHash: hash('wrong-endpoint'),
        secret: nextSecret,
        idempotencyKey: 'rotate-secret-wrong-key',
        requestHash: hash('rotate-secret-wrong-key'),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const afterWrongKey = await ownerQuery(
      `select endpoint.current_secret_version_id,
              (select count(*)::integer from app.webhook_trigger_secret_versions
                where trigger_id=$1) secret_count
         from app.webhook_trigger_endpoints endpoint where endpoint.trigger_id=$1`,
      [resources.webhookId],
    );
    expect(afterWrongKey.rows).toEqual(beforeWrongKey.rows);
    await webhook.rotateSecret({
      workspaceId,
      workflowId: scenarioWorkflowId,
      actorId,
      triggerId: resources.webhookId,
      endpointKeyHash: nextEndpointHash,
      secret: nextSecret,
      idempotencyKey: 'rotate-secret',
      requestHash: hash('rotate-secret'),
    });
    const after = await webhook.resolveVerification(nextEndpointHash);
    expect(after?.currentSecret.id).toBe(nextSecret.id);
    expect(after?.previousSecret?.id).toBe(
      beforeSecretRotation.currentSecret.id,
    );
    const overlapMillis =
      (after?.previousSecret?.validUntil.getTime() ?? 0) -
      (after?.databaseTime.getTime() ?? 0);
    expect(overlapMillis).toBeGreaterThanOrEqual(299_000);
    expect(overlapMillis).toBeLessThanOrEqual(301_000);
    if (after?.previousSecret === undefined)
      throw new Error('Expected a previous secret overlap');
    await expect(
      acceptWebhook({
        verification: after,
        verifiedSecretVersionId: after.previousSecret.id,
        requestFingerprint: hash('previous-secret-before-expiry'),
        runInput: webhookRunInput(
          after.runInputMode,
          post({ event: 'previous-secret-before-expiry' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ replayed: false });
    const expiredSecret = await apiQuery<{
      current_secret_version_id: string;
      expired: boolean;
      previous_secret_version_id: string;
    }>(
      `update app.webhook_trigger_endpoints
          set previous_secret_valid_until=clock_timestamp()-interval '1 second'
        where workspace_id=$1 and id=$2
        returning current_secret_version_id,previous_secret_version_id,
          previous_secret_valid_until<=clock_timestamp() expired`,
      [workspaceId, after.endpointId],
    );
    expect(expiredSecret.rows).toEqual([
      {
        current_secret_version_id: nextSecret.id,
        previous_secret_version_id: after.previousSecret.id,
        expired: true,
      },
    ]);
    const expiredReference =
      await webhook.resolveVerification(nextEndpointHash);
    if (expiredReference === null)
      throw new Error('Expected endpoint after previous-secret expiry');
    await expect(
      acceptWebhook({
        verification: expiredReference,
        verifiedSecretVersionId: after.previousSecret.id,
        requestFingerprint: hash('previous-secret-after-expiry'),
        runInput: webhookRunInput(
          expiredReference.runInputMode,
          post({ event: 'previous-secret-after-expiry' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
  });

  it('rolls back replay and delivery admission when workspace eligibility changes', async () => {
    const { verification } = await createWebhookScenario();
    await ownerQuery(
      "update app.workspaces set status='suspended' where id=$1",
      [workspaceId],
    );
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('rollback-payload'),
      idempotencyKeyHash: hash('rollback-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'rollback' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    await expect(acceptWebhook(input)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    await ownerQuery("update app.workspaces set status='active' where id=$1", [
      workspaceId,
    ]);
    await expect(acceptWebhook(input)).resolves.toMatchObject({
      replayed: false,
    });
  });
}
