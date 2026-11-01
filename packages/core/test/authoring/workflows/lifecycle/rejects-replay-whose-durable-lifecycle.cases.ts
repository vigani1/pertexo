import { expect, it } from 'vitest';
import {
  actorId,
  apiPool,
  archiveWrite,
  authoring,
  createHash,
  currentRepresentationTag,
  emptyGraph,
  failAtWrite,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { lifecycleFacts } from './fixture.js';

export function registerRejectsReplayWhoseDurableLifecycle(): void {
  it.each(['workspaceId', 'id'] as const)(
    'rejects a replay whose durable lifecycle workflow %s does not match its claim',
    async (identityField) => {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `lifecycle-corrupt-create-${identityField}`,
        name: `Lifecycle corrupt ${identityField}`,
        workspaceId,
      });
      const idempotencyKey = `lifecycle-corrupt-archive-${identityField}`;
      const command = {
        actorId,
        command: 'archive' as const,
        expectedLifecycleRevision: 1,
        idempotencyKey,
        workflowId: created.workflowId,
        workspaceId,
      };
      await expect(
        authoring.transitionWorkflowLifecycle(command),
      ).resolves.toMatchObject({ replayed: false });
      await queryAsOwner(
        `update app.idempotency_records
            set result_ref=jsonb_set(
              result_ref,$2::text[],to_jsonb($3::text),false)
          where workspace_id=$4 and operation='workflow.archive'
            and key_hash=$1
          returning key_hash`,
        [
          createHash('sha256').update(idempotencyKey).digest('hex'),
          ['workflow', identityField],
          randomUUID(),
          workspaceId,
        ],
        workspaceId,
      );

      await expect(
        authoring.transitionWorkflowLifecycle(command),
      ).rejects.toThrow(
        'Stored workflow command result names another workflow',
      );
    },
  );

  it('grants the API runtime only the new lifecycle revision column', async () => {
    const result = await apiPool.query<{
      lifecycle_revision: boolean;
      id: boolean;
      workspace_id: boolean;
      created_by: boolean;
    }>(
      `select
         has_column_privilege(current_user,'app.workflows','lifecycle_revision','UPDATE') lifecycle_revision,
         has_column_privilege(current_user,'app.workflows','id','UPDATE') id,
         has_column_privilege(current_user,'app.workflows','workspace_id','UPDATE') workspace_id,
         has_column_privilege(current_user,'app.workflows','created_by','UPDATE') created_by`,
    );
    expect(result.rows[0]).toEqual({
      lifecycle_revision: true,
      id: false,
      workspace_id: false,
      created_by: false,
    });
  });

  it('rolls back every lifecycle step, including the idempotency claim', async () => {
    const steps = [
      'claim',
      'workflow',
      'outbox',
      'audit',
      'idempotency',
    ] as const;

    for (const step of steps) {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `lifecycle-rollback-create-${step}`,
        name: `Lifecycle rollback ${step}`,
        workspaceId,
      });
      await authoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
        ),
        idempotencyKey: `lifecycle-rollback-publish-${step}`,
        requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        workflowId: created.workflowId,
        workspaceId,
      });
      const before = await lifecycleFacts(created.workflowId);
      const fault = await failAtWrite(archiveWrite(step, created.workflowId));
      try {
        await expect(
          authoring.transitionWorkflowLifecycle({
            actorId,
            command: 'archive',
            expectedLifecycleRevision: 1,
            idempotencyKey: `lifecycle-rollback-${step}`,
            workflowId: created.workflowId,
            workspaceId,
          }),
        ).rejects.toThrow(fault.message);
      } finally {
        await fault.remove();
      }
      expect(await lifecycleFacts(created.workflowId)).toEqual(before);
      await expect(
        authoring.transitionWorkflowLifecycle({
          actorId,
          command: 'archive',
          expectedLifecycleRevision: 1,
          idempotencyKey: `lifecycle-rollback-${step}`,
          workflowId: created.workflowId,
          workspaceId,
        }),
      ).resolves.toMatchObject({
        replayed: false,
        workflow: { lifecycleStatus: 'archived', lifecycleRevision: 2 },
      });
      expect(await lifecycleFacts(created.workflowId)).toMatchObject({
        lifecycleStatus: 'archived',
        lifecycleRevision: 2,
        idempotencyClaims: 1,
        reconciliationOutbox: 2,
        auditEvents: 1,
      });
    }
  });
}
