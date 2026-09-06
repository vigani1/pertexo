import { describe, expect, it } from 'vitest';

import {
  actorId,
  authoring,
  emptyGraph,
  queryAsOwner,
  workspaceId,
} from './support/workflow-authoring.integration.support.js';

describe('persisted workflow activation projection', () => {
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
