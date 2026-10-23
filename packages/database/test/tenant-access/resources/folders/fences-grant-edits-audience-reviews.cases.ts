import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  actorId,
  authoring,
  emptyGraph,
  queryAsOwner,
  workspaceId,
} from '../../../support/workflow-authoring.js';

import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';
import { builder, viewer, folders } from './fixture.js';

export function registerFencesGrantEditsAudienceReviews(): void {
  it('fences grant edits, audience reviews and replayed authoring commands with current authority', async () => {
    const privateFolder = (
      await folders.createFolder({
        workspaceId,
        actorId,
        name: 'Reviewed audience',
        parentId: null,
        idempotencyKey: randomUUID(),
      })
    ).folder;
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Scoped creation',
      emptyGraph,
      folderId: privateFolder.id,
      idempotencyKey: randomUUID(),
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: privateFolder.id,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: 1,
        grants: [{ kind: 'member', userId: builder, access: 'editor' }],
      },
    });
    expect(
      (await authoring.getWorkflow(workspaceId, created.workflowId, builder))
        ?.resourceAccess,
    ).toEqual({ canEdit: true, canPublish: true });
    expect(
      (
        await folders.readSharing({
          workspaceId,
          folderId: privateFolder.id,
          actorId,
        })
      ).labels?.[builder],
    ).toBe('Resource reader');
    expect(
      await authoring.getDraft(workspaceId, created.workflowId, viewer),
    ).toBeNull();
    expect(
      await authoring.getDraft(workspaceId, created.workflowId, builder),
    ).not.toBeNull();
    await expect(
      folders.replaceSharing({
        workspaceId,
        actorId: builder,
        folderId: privateFolder.id,
        idempotencyKey: randomUUID(),
        request: { mode: 'workspace', expectedFolderRevision: 2, grants: [] },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    const move = {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      folderId: null,
      expectedOrganizationRevision: 1,
    };
    await expect(
      folders.placeWorkflow({
        ...move,
        actorId: builder,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: 'audience_review' });
    const request = {
      kind: 'workflows' as const,
      workflowIds: [created.workflowId],
      destinationFolderId: null,
    };
    const reviewed = (
      await folders.reviewMove({ workspaceId, actorId, request })
    ).items[0];
    if (reviewed === undefined) throw new Error('Audience review missing');
    expect(reviewed.requiresReview).toBe(true);
    expect(reviewed.removedRestrictions.map(({ id }) => id)).toEqual([
      privateFolder.id,
    ]);
    await folders.renameFolder({
      workspaceId,
      actorId,
      folderId: privateFolder.id,
      expectedFolderRevision: 2,
      name: 'Changed audience',
      idempotencyKey: randomUUID(),
    });
    await expect(
      folders.placeWorkflow({
        ...move,
        audienceReview: { token: reviewed.token, acknowledge: true },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: 'audience_review' });
    const current = (
      await folders.reviewMove({ workspaceId, actorId, request })
    ).items[0];
    if (current === undefined) throw new Error('Audience review missing');
    await folders.placeWorkflow({
      ...move,
      audienceReview: { token: current.token, acknowledge: true },
      idempotencyKey: randomUUID(),
    });
    await folders.placeWorkflow({
      workspaceId,
      actorId: builder,
      workflowId: created.workflowId,
      folderId: privateFolder.id,
      expectedOrganizationRevision: 2,
      idempotencyKey: randomUUID(),
    });
    const rename = {
      workspaceId,
      actorId: builder,
      workflowId: created.workflowId,
      name: 'Renamed while allowed',
      expectedNameRevision: 1,
      idempotencyKey: randomUUID(),
    };
    await authoring.renameWorkflow(rename);
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: privateFolder.id,
      idempotencyKey: randomUUID(),
      request: { mode: 'restricted', expectedFolderRevision: 3, grants: [] },
    });
    await expect(authoring.renameWorkflow(rename)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    const audit = await queryAsOwner<{ metadata: Record<string, unknown> }>(
      "select metadata from app.audit_events where workspace_id=$1 and action='workflow.folder_sharing_changed' and target_id=$2 order by id",
      [workspaceId, privateFolder.id],
      workspaceId,
    );
    expect(audit).toHaveLength(2);
  });
}
