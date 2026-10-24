import { describe, expect, it } from 'vitest';
import {
  actorId,
  authoring,
  emptyGraph,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../support/workflow-authoring.js';

describe('workflow activation projection', () => {
  it.each([
    'inactive',
    'activating',
    'active',
    'deactivating',
    'degraded',
    'error',
  ] as const)(
    'preserves persisted %s health independently of lifecycle',
    async (status) => {
      const { workflowId } = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: randomUUID(),
        name: 'Trigger health',
        workspaceId,
      });
      for (const lifecycleStatus of ['active', 'archived'] as const) {
        await queryAsOwner(
          'update app.workflows set activation_status=$1,lifecycle_status=$2 where workspace_id=$3 and id=$4',
          [status, lifecycleStatus, workspaceId, workflowId],
          workspaceId,
        );
        expect(
          await authoring.getWorkflow(workspaceId, workflowId, actorId),
        ).toMatchObject({ activationStatus: status, lifecycleStatus });
      }
    },
  );
  it.each(['enabled', '', null, undefined, 1])(
    'rejects invalid persisted activation %s at storage',
    async (status) => {
      const { workflowId } = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: randomUUID(),
        name: 'Invalid trigger health',
        workspaceId,
      });
      await expect(
        queryAsOwner(
          'update app.workflows set activation_status=$1 where workspace_id=$2 and id=$3',
          [status, workspaceId, workflowId],
          workspaceId,
        ),
      ).rejects.toMatchObject({ code: status == null ? '23502' : '23514' });
    },
  );
});
