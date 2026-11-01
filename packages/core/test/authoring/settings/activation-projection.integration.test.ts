import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { createWorkflowOrganizationReadDatabase } from '../../../src/authoring/organization/workflows.queries.js';

import {
  apiUrl,
  apiPool,
  parseDatabaseConfig,
  currentRepresentationTag,
  actorId,
  authoring,
  emptyGraph,
  queryAsOwner,
  workspaceId,
} from '../../support/workflow-authoring.js';

describe('persisted workflow activation projection', () => {
  it('projects missing endpoints for the published version in both lists and detail', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      emptyGraph,
      name: 'Webhook setup projection',
      idempotencyKey: randomUUID(),
    });
    const published = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    const triggerId = randomUUID();
    await queryAsOwner(
      `insert into app.workflow_triggers
      (id, workspace_id, workflow_id, workflow_version_id, node_id, kind, desired_config, config_fingerprint)
      values ($1,$2,$3,$4,'incoming','webhook','{}',$5)`,
      [
        triggerId,
        workspaceId,
        created.workflowId,
        published.version.id,
        `trigger:sha256:${'a'.repeat(64)}`,
      ],
      workspaceId,
    );
    const organization = createWorkflowOrganizationReadDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    try {
      expect(
        await authoring.getWorkflow(workspaceId, created.workflowId, actorId),
      ).toMatchObject({ webhookSetupRequired: true });
      expect(
        (await authoring.listWorkflows({ workspaceId, actorId })).items.find(
          (item) => item.id === created.workflowId,
        ),
      ).toMatchObject({ webhookSetupRequired: true });
      expect(
        (await organization.listWorkflows({ workspaceId, actorId })).items.find(
          (item) => item.workflow.id === created.workflowId,
        )?.workflow,
      ).toMatchObject({ webhookSetupRequired: true });
      expect(
        (
          await authoring.getWorkflowWithTemplateOrigin(
            workspaceId,
            created.workflowId,
            actorId,
          )
        )?.workflow,
      ).toMatchObject({ webhookSetupRequired: true });
      await withTenantScopedClient(
        apiPool,
        { workspaceId, actorId },
        async (client) => {
          const secretId = randomUUID();
          await client.query(
            `insert into app.webhook_trigger_secret_versions
        (id,workspace_id,trigger_id,workflow_id,node_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
        select $1,workspace_id,id,workflow_id,node_id,'fixture','fixture','fixture','fixture','fixture',$4
          from app.workflow_triggers where workspace_id=$2 and id=$3`,
            [secretId, workspaceId, triggerId, actorId],
          );
          await client.query(
            `insert into app.webhook_trigger_endpoints
        (id,workspace_id,workflow_id,node_id,endpoint_key_hash,current_secret_version_id)
        select $1,workspace_id,workflow_id,node_id,$4,$5
          from app.workflow_triggers where workspace_id=$2 and id=$3`,
            [randomUUID(), workspaceId, triggerId, 'b'.repeat(64), secretId],
          );
        },
      );
      expect(
        await authoring.getWorkflow(workspaceId, created.workflowId, actorId),
      ).toMatchObject({ webhookSetupRequired: false });
      await withTenantScopedClient(
        apiPool,
        { workspaceId, actorId },
        (client) =>
          client.query(
            "update app.webhook_trigger_endpoints set status='disabled' where workflow_id=$1",
            [created.workflowId],
          ),
      );
      expect(
        await authoring.getWorkflow(workspaceId, created.workflowId, actorId),
      ).toMatchObject({ webhookSetupRequired: true });
      // Historical trigger rows cannot make an unpublished workflow need setup.
      await queryAsOwner(
        'update app.workflows set published_version_id=null where id=$1',
        [created.workflowId],
        workspaceId,
      );
      expect(
        await authoring.getWorkflow(workspaceId, created.workflowId, actorId),
      ).toMatchObject({ webhookSetupRequired: false });
    } finally {
      await organization.close();
    }
  });

  it('returns every stored health state through the serving-role authoring list', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Activation projection proof',
      emptyGraph,
      idempotencyKey: 'activation-projection-proof',
    });
    expect(created.workflow.activationStatus).toBe('inactive');
    for (const status of [
      'inactive',
      'activating',
      'active',
      'deactivating',
      'degraded',
      'error',
    ]) {
      await queryAsOwner(
        'update app.workflows set activation_status = $1 where id = $2',
        [status, created.workflowId],
        workspaceId,
      );
      const result = await authoring.listWorkflows({ workspaceId, actorId });
      expect(
        result.items.find((item) => item.id === created.workflowId),
      ).toMatchObject({ activationStatus: status, lifecycleStatus: 'active' });
    }
  });
});
