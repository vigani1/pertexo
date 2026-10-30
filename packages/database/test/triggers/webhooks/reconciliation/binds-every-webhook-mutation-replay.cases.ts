import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { WebhookTriggerNotFoundError } from '../../../../src/triggers/webhooks/errors.js';

import {
  actorId,
  workspaceId,
  hash,
  secret,
  reconciliation,
  webhook,
  workflowTriggerIds,
  publishTriggerWorkflow,
} from '../fixture.js';

export function registerBindsEveryWebhookMutationReplay(): void {
  it('binds every webhook mutation and replay to its workflow parent', async () => {
    const target = await publishTriggerWorkflow();
    const other = await publishTriggerWorkflow();
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: target.created.workflowId,
        publishedVersionId: target.published.version.id,
        outboxEventId: target.eventId,
        delivery: {
          outboxEventId: target.eventId,
          payloadChecksum: target.eventChecksum,
        },
      }),
    ).resolves.toHaveLength(2);
    const ids = await workflowTriggerIds(target.created.workflowId);
    const missingWorkflowId = randomUUID();
    const wrongWorkspaceId = randomUUID();
    const provision = {
      workspaceId,
      workflowId: target.created.workflowId,
      actorId,
      triggerId: ids.webhookId,
      endpointId: randomUUID(),
      endpointKeyHash: hash(randomUUID()),
      secret: secret(),
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    };
    for (const invalid of [
      { workflowId: other.created.workflowId },
      { workflowId: missingWorkflowId },
      { workspaceId: wrongWorkspaceId },
    ]) {
      await expect(
        webhook.provision({ ...provision, ...invalid }),
      ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    }
    await expect(webhook.provision(provision)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: false,
    });
    await expect(webhook.provision(provision)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: true,
    });

    const endpointKeyHash = hash(randomUUID());
    const rotateEndpoint = {
      workspaceId,
      workflowId: target.created.workflowId,
      actorId,
      triggerId: ids.webhookId,
      endpointKeyHash,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    };
    for (const invalid of [
      { workflowId: other.created.workflowId },
      { workflowId: missingWorkflowId },
      { workspaceId: wrongWorkspaceId },
    ]) {
      await expect(
        webhook.rotateEndpoint({ ...rotateEndpoint, ...invalid }),
      ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    }
    await expect(webhook.rotateEndpoint(rotateEndpoint)).resolves.toMatchObject(
      { trigger: { id: ids.webhookId }, replayed: false },
    );
    await expect(webhook.rotateEndpoint(rotateEndpoint)).resolves.toMatchObject(
      { trigger: { id: ids.webhookId }, replayed: true },
    );

    const rotateSecret = {
      workspaceId,
      workflowId: target.created.workflowId,
      actorId,
      triggerId: ids.webhookId,
      endpointKeyHash,
      secret: secret(),
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    };
    for (const invalid of [
      { workflowId: other.created.workflowId },
      { workflowId: missingWorkflowId },
      { workspaceId: wrongWorkspaceId },
    ]) {
      await expect(
        webhook.rotateSecret({ ...rotateSecret, ...invalid }),
      ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    }
    await expect(webhook.rotateSecret(rotateSecret)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: false,
    });
    await expect(webhook.rotateSecret(rotateSecret)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: true,
    });
  });
}
