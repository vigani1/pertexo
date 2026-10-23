import { expect, it } from 'vitest';
import {
  actorId,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerRestoresFreshTagIdenticalGraph(): void {
  it('restores a fresh tag for an identical graph', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'restore-identical-create',
      name: 'Restore identical',
      workspaceId,
    });
    const version = await authoring.publishWorkflow({
      actorId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: 'restore-identical-publish',
      requestHash: '4'.repeat(64),
      workflowId: created.workflowId,
      workspaceId,
    });
    const tag = await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    });
    await expect(
      authoring.restoreWorkflowVersion({
        actorId,
        representationTag: tag,
        versionId: version.version.id,
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ revision: 2, graphJson: emptyGraph });
  });
}
