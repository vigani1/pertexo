import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  hash,
  schedules,
  workerQuery,
  appendReconciliationEvent,
  deliverReconciliation,
  setWorkflowLifecycle,
  publishTriggerWorkflow,
  provisionWebhook,
  triggerFacts,
  workflowState,
} from '../fixture.js';

export function registerRestoresActiveResourcesPreservingExplicit(): void {
  it('restores active resources while preserving explicit disablement across worker events', async () => {
    const disabledWorkflow = await publishTriggerWorkflow();
    const disabledStart = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await deliverReconciliation(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
      disabledStart,
    );
    const disabledResources = await provisionWebhook(
      disabledWorkflow.created.workflowId,
    );
    await schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId: disabledWorkflow.created.workflowId,
      triggerId: disabledResources.scheduleId,
      enabled: false,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    });
    await workerQuery(
      `update app.webhook_trigger_endpoints set status='disabled',updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2`,
      [workspaceId, disabledResources.endpointId],
    );
    await expect(
      triggerFacts(disabledWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_id: disabledResources.endpointId,
          endpoint_status: 'disabled',
          kind: 'webhook',
        }),
      ]),
    );
    await setWorkflowLifecycle(
      disabledWorkflow.created.workflowId,
      'archived',
      'deactivating',
    );
    const archiveEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        archiveEvent,
      ),
    ).resolves.toHaveLength(2);
    // Persist while archived, but delay delivery until after restore converges.
    const lateEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await setWorkflowLifecycle(
      disabledWorkflow.created.workflowId,
      'active',
      'activating',
    );
    const restoreEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        restoreEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'disabled' }),
        expect.objectContaining({ nodeId: 'webhook', status: 'disabled' }),
      ]),
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        lateEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'disabled' }),
        expect.objectContaining({ nodeId: 'webhook', status: 'disabled' }),
      ]),
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        restoreEvent,
      ),
    ).resolves.toEqual([]);
    await expect(
      workflowState(disabledWorkflow.created.workflowId),
    ).resolves.toMatchObject({
      activation_status: 'inactive',
      lifecycle_status: 'active',
    });
    await expect(
      triggerFacts(disabledWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'disabled',
          kind: 'webhook',
          status: 'disabled',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'disabled',
          status: 'disabled',
        }),
      ]),
    );

    const activeWorkflow = await publishTriggerWorkflow();
    const activeStart = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await deliverReconciliation(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
      activeStart,
    );
    await provisionWebhook(activeWorkflow.created.workflowId);
    await setWorkflowLifecycle(
      activeWorkflow.created.workflowId,
      'archived',
      'deactivating',
    );
    const activeArchive = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await deliverReconciliation(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
      activeArchive,
    );
    await setWorkflowLifecycle(
      activeWorkflow.created.workflowId,
      'active',
      'activating',
    );
    const activeRestore = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        activeWorkflow.created.workflowId,
        activeWorkflow.published.version.id,
        activeRestore,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'active' }),
        expect.objectContaining({
          endpointReady: true,
          nodeId: 'webhook',
          status: 'active',
        }),
      ]),
    );
    await expect(
      workflowState(activeWorkflow.created.workflowId),
    ).resolves.toMatchObject({
      activation_status: 'active',
      lifecycle_status: 'active',
    });
    await expect(
      triggerFacts(activeWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'active',
          kind: 'webhook',
          status: 'active',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'enabled',
          status: 'active',
        }),
      ]),
    );
  });
}
