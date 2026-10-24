import { expect, it } from 'vitest';

import { WorkflowTriggerStalePublicationError } from '../../../../src/triggers/reconciliation/errors.js';

import {
  actorId,
  workspaceId,
  reconciliation,
  webhook,
  ownerQuery,
  appendReconciliationEvent,
  deliverReconciliation,
  setWorkflowLifecycle,
  immutableWorkflowHistory,
  publishTriggerWorkflow,
  publishNextTriggerWorkflowVersion,
  provisionWebhook,
  triggerFacts,
  workflowState,
} from '../fixture.js';

export function registerProjectsPartialGlobalArchivedFailures(): void {
  it('projects partial, global, and archived failures without overwriting trigger facts', async () => {
    const { created, published } = await publishTriggerWorkflow();
    const start = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await deliverReconciliation(
      created.workflowId,
      published.version.id,
      start,
    );
    const resources = await provisionWebhook(created.workflowId);

    await ownerQuery(
      `update app.workflow_triggers set status='configuration_required',
         health_status='pending',last_error_code=null
         where workspace_id=$1 and id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_partial_failure',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'healthy',
          kind: 'webhook',
          last_error_code: null,
          status: 'active',
        }),
        expect.objectContaining({
          health_status: 'unhealthy',
          kind: 'schedule',
          last_error_code: 'provider_partial_failure',
          status: 'error',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'degraded',
      lifecycle_status: 'active',
    });

    await ownerQuery(
      `update app.trigger_schedules set status='disabled',health_status='disabled',
         last_error_code=null where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await ownerQuery(
      `update app.workflow_triggers set status='disabled',health_status='disabled',
         last_error_code=null where workspace_id=$1 and id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_disabled_resource',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'healthy',
          kind: 'webhook',
          last_error_code: null,
          status: 'active',
        }),
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          schedule_health_status: 'disabled',
          schedule_status: 'disabled',
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'degraded',
    });

    await ownerQuery(
      `update app.workflow_triggers set status='pending',health_status='pending'
         where workspace_id=$1 and id=$2`,
      [workspaceId, resources.webhookId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_global_failure',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'unhealthy',
          kind: 'webhook',
          last_error_code: 'provider_global_failure',
          status: 'error',
        }),
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'error',
    });

    await setWorkflowLifecycle(created.workflowId, 'archived', 'deactivating');
    const archiveEvent = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await deliverReconciliation(
      created.workflowId,
      published.version.id,
      archiveEvent,
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      reason: 'provider_archived_failure',
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          status: 'disabled',
        }),
        expect.objectContaining({
          endpoint_status: 'active',
          health_status: 'disabled',
          kind: 'webhook',
          last_error_code: null,
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'error',
      lifecycle_status: 'archived',
    });
  });

  it('rejects an old-version event without rewriting current health or history', async () => {
    const first = await publishTriggerWorkflow();
    await reconciliation.reconcile({
      workspaceId,
      workflowId: first.created.workflowId,
      publishedVersionId: first.published.version.id,
      outboxEventId: first.eventId,
    });
    const firstResources = await provisionWebhook(first.created.workflowId);
    await expect(
      webhook.resolveVerification(firstResources.endpointKeyHash),
    ).resolves.not.toBeNull();
    const second = await publishNextTriggerWorkflowVersion(
      first.created.workflowId,
    );
    const latestHealth = await reconciliation.reconcile({
      workspaceId,
      workflowId: first.created.workflowId,
      publishedVersionId: second.published.version.id,
      outboxEventId: second.eventId,
    });
    const historyBeforeStaleDelivery = await immutableWorkflowHistory(
      first.created.workflowId,
    );
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: first.created.workflowId,
        publishedVersionId: first.published.version.id,
        outboxEventId: first.eventId,
        delivery: {
          outboxEventId: first.eventId,
          payloadChecksum: first.eventChecksum,
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowTriggerStalePublicationError);
    await expect(
      webhook.getHealth({
        workspaceId,
        actorId,
        workflowId: first.created.workflowId,
      }),
    ).resolves.toEqual(latestHealth);
    await expect(
      immutableWorkflowHistory(first.created.workflowId),
    ).resolves.toEqual(historyBeforeStaleDelivery);
    await expect(
      workflowState(first.created.workflowId),
    ).resolves.toMatchObject({
      lifecycle_status: 'active',
      published_version_id: second.published.version.id,
    });
  });
}
