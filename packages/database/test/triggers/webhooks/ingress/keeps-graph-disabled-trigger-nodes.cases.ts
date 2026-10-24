import { webhookRunInput } from '@pertexo/nodes-core';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  WebhookDeliveryIneligibleError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerNotFoundError,
} from '../../../../src/triggers/webhooks/errors.js';

import {
  actorId,
  workspaceId,
  hash,
  secret,
  post,
  acceptWebhook,
  webhook,
  checkpointFactory,
  deliverReconciliation,
  publishTriggerWorkflow,
  provisionWebhook,
  createWebhookScenario,
} from '../fixture.js';

export function registerKeepsGraphDisabledTriggerNodes(): void {
  it('keeps graph-disabled trigger nodes externally materialized for execution-time skipping', async () => {
    const published = await publishTriggerWorkflow(true);
    const health = await deliverReconciliation(
      published.created.workflowId,
      published.published.version.id,
      {
        eventId: published.eventId,
        payloadChecksum: published.eventChecksum,
      },
    );
    expect(health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'active' }),
        expect.objectContaining({
          nodeId: 'webhook',
          status: 'configuration_required',
        }),
      ]),
    );
    const resources = await provisionWebhook(published.created.workflowId);
    const verification = await webhook.resolveVerification(
      resources.endpointKeyHash,
    );
    if (verification === null)
      throw new Error('Expected graph-disabled external endpoint');
    await expect(
      acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('graph-disabled-ingress'),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ event: 'graph-disabled-ingress' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('configures authentication atomically, rotates across modes and fences stale proof even for retries', async () => {
    const { published, resources, verification } =
      await createWebhookScenario();
    const nextKey = hash(randomUUID());
    const nextSecret = secret();
    const authentication = {
      mode: 'secret_url' as const,
      allowedOrigins: ['https://app.example'],
    };
    const command = {
      workspaceId,
      actorId,
      workflowId: published.created.workflowId,
      triggerId: resources.webhookId,
      authentication,
      endpointKeyHash: nextKey,
      secret: nextSecret,
      idempotencyKey: randomUUID(),
      requestHash: hash('url-mode'),
    };
    const old = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('auth-before'),
      idempotencyKeyHash: hash('auth-before'),
      runInput: webhookRunInput(verification.runInputMode, post({})),
      bodyBytes: 2,
      checkpointFactory,
    };
    await acceptWebhook(old);
    await expect(
      webhook.configureAuthentication({ ...command, workflowId: randomUUID() }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    expect(await webhook.configureAuthentication(command)).toMatchObject({
      replayed: false,
      rotated: true,
      trigger: { authentication },
    });
    expect(
      await webhook.configureAuthentication({ ...command, secret: secret() }),
    ).toMatchObject({ replayed: true, rotated: false });
    await expect(
      webhook.resolveVerification(resources.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(acceptWebhook(old)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    const url = await webhook.resolveVerification(nextKey);
    expect(url).toMatchObject({
      authentication,
      currentSecret: { id: nextSecret.id },
    });
    expect(url?.previousSecret).toBeUndefined();
    if (url === null) throw new Error('URL endpoint unavailable');
    const input = {
      ...old,
      verification: url,
      verifiedSecretVersionId: nextSecret.id,
      requestFingerprint: hash('url-body'),
      idempotencyKeyHash: hash('url-body'),
    };
    const accepted = await acceptWebhook(input);
    expect(await acceptWebhook(input)).toEqual({
      ...accepted,
      replayed: true,
    });
    await expect(
      webhook.rotateSecret({
        ...command,
        endpointKeyHash: nextKey,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const origins = {
      ...authentication,
      allowedOrigins: ['https://other.example'],
    };
    expect(
      await webhook.configureAuthentication({
        ...command,
        authentication: origins,
        idempotencyKey: randomUUID(),
        requestHash: hash('origins-only'),
        endpointKeyHash: hash(randomUUID()),
        secret: secret(),
      }),
    ).toMatchObject({ rotated: false });
    expect(await webhook.resolveVerification(nextKey)).toMatchObject({
      authentication: origins,
      currentSecret: { id: nextSecret.id },
    });
    await expect(acceptWebhook(input)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    const headerKey = hash(randomUUID());
    expect(
      await webhook.configureAuthentication({
        ...command,
        authentication: {
          mode: 'header_secret',
          headerName: 'authorization',
          allowedOrigins: [],
        },
        endpointKeyHash: headerKey,
        secret: secret(),
        idempotencyKey: randomUUID(),
        requestHash: hash('header-mode'),
      }),
    ).toMatchObject({ rotated: true });
    await expect(webhook.resolveVerification(nextKey)).resolves.toBeNull();
    expect(
      (await webhook.resolveVerification(headerKey))?.previousSecret,
    ).toBeUndefined();
  });

  it('enforces the endpoint ingress boundary atomically under concurrency', async () => {
    const { resources } = await createWebhookScenario();
    const attempts = await Promise.allSettled(
      Array.from({ length: 61 }, () =>
        webhook.consumeIngressLimit(resources.endpointKeyHash),
      ),
    );
    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(60);
    const denied = attempts.filter(({ status }) => status === 'rejected');
    expect(denied).toHaveLength(1);
    expect((denied[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WebhookIngressRateLimitExceededError,
    );
  });
}
