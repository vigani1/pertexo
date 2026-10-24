import { webhookRunInput } from '@pertexo/nodes-core';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {checkDatabaseReadiness, EXPECTED_MIGRATION_HEAD} from '../../../../src/platform/readiness.queries.js';
import {
  WebhookDeliveryIneligibleError,
  WebhookTriggerNotFoundError,
} from '../../../../src/triggers/webhooks/database.js';

import { ScheduleTriggerError } from '../../../../src/triggers/schedules/errors.js';

import { withWorkspaceTransaction } from '../../../../src/tenant-access/transactions.js';

import { isScheduleClaimEligible } from '../../../../src/triggers/schedules/scanner.js';
import {
  actorId,
  workspaceId,
  workflowId,
  versionId,
  triggerId,
  endpointId,
  outboxEventId,
  hash,
  endpointHash,
  secret,
  post,
  acceptWebhook,
  reconciliation,
  schedules,
  webhook,
  readinessPool,
  workerReadinessPool,
  workerPool,
  ownerQuery,
  workerQuery,
  checkpointFactory,
  appendReconciliationEvent,
  deliverReconciliation,
  setWorkflowLifecycle,
  immutableWorkflowHistory,
  publishTriggerWorkflow,
  provisionWebhook,
  triggerFacts,
  workflowState,
} from '../fixture.js';

export function registerAppliesArchiveStateAtReconciliation(): void {
  it('applies archive state at reconciliation and gates new trigger work', async () => {
    const { created, published } = await publishTriggerWorkflow();
    const event = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await expect(
      deliverReconciliation(created.workflowId, published.version.id, event),
    ).resolves.toHaveLength(2);
    const provisioned = await provisionWebhook(created.workflowId);
    const verification = await webhook.resolveVerification(
      provisioned.endpointKeyHash,
    );
    if (verification === null) throw new Error('Expected webhook verification');
    const historyBeforeArchive = await immutableWorkflowHistory(
      created.workflowId,
    );
    await ownerQuery(
      `update app.trigger_schedules set next_fire_at=clock_timestamp()-interval '1 minute'
         where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, provisioned.scheduleId],
    );
    await setWorkflowLifecycle(created.workflowId, 'archived', 'deactivating');
    await expect(
      webhook.resolveVerification(provisioned.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(
      acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('archived-webhook-admission'),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ archived: true }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
    const claimed = await workerQuery<{
      lease_token: string;
      trigger_id: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`archive-gate-${randomUUID()}`],
    );
    expect(claimed.rows).toHaveLength(1);
    const claim = claimed.rows[0];
    if (claim === undefined) throw new Error('Archived schedule claim missing');
    await expect(
      withWorkspaceTransaction(workerPool, workspaceId, (transaction) =>
        isScheduleClaimEligible(transaction, claim),
      ),
    ).resolves.toBe(false);
    await workerQuery('select app.release_trigger_schedule_claim($1,$2)', [
      claim.trigger_id,
      claim.lease_token,
    ]);
    await expect(
      schedules.setEnabled({
        workspaceId,
        actorId,
        workflowId: created.workflowId,
        triggerId: provisioned.scheduleId,
        enabled: true,
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toBeInstanceOf(ScheduleTriggerError);
    await expect(
      webhook.rotateEndpoint({
        workspaceId,
        workflowId: created.workflowId,
        actorId,
        triggerId: provisioned.webhookId,
        endpointKeyHash: hash(`archived-rotation-${randomUUID()}`),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const archiveEvent = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await expect(
      deliverReconciliation(
        created.workflowId,
        published.version.id,
        archiveEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          healthStatus: 'disabled',
          nodeId: 'schedule',
          status: 'disabled',
        }),
        expect.objectContaining({
          endpointReady: true,
          healthStatus: 'disabled',
          nodeId: 'webhook',
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'inactive',
      lifecycle_status: 'archived',
      published_version_id: published.version.id,
    });
    await expect(immutableWorkflowHistory(created.workflowId)).resolves.toEqual(
      historyBeforeArchive,
    );
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'active',
          kind: 'webhook',
          status: 'disabled',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'enabled',
          status: 'disabled',
        }),
      ]),
    );
  });

  it('migrates from zero, reconciles configuration, and exposes no hashes or secrets in health', async () => {
    await expect(checkDatabaseReadiness(readinessPool)).resolves.toMatchObject({
      migrationHead: EXPECTED_MIGRATION_HEAD,
    });
    await expect(
      checkDatabaseReadiness(workerReadinessPool),
    ).resolves.toMatchObject({
      role: 'pertexo_app',
    });
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: versionId,
        outboxEventId,
      }),
    ).resolves.toMatchObject([
      { id: triggerId, status: 'configuration_required', endpointReady: false },
    ]);
    const health = await webhook.provision({
      workspaceId,
      workflowId,
      actorId,
      triggerId,
      endpointId,
      endpointKeyHash: endpointHash,
      secret: secret(),
      idempotencyKey: 'provision',
      requestHash: hash('provision'),
    });
    expect(health).toMatchObject({ status: 'active', endpointReady: true });
    expect(JSON.stringify(health)).not.toMatch(
      /hash|cipher|secret|nonce|authTag/u,
    );
    await expect(
      webhook.getHealth({
        workspaceId,
        actorId: randomUUID(),
        workflowId,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
}
