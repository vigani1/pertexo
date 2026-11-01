import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  authoring,
  queryAsOwner,
  workspaceId,
  workflowId,
} from '../../../support/workflow-authoring.js';

import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';
import {
  builder,
  viewer,
  folderId,
  publicId,
  privateRun,
  publicRun,
  folders,
  organization,
  runs,
} from './fixture.js';

export function registerOmitsInaccessibleWorkflowsRetainedRun(): void {
  it('omits inaccessible workflows and retained run data, before pagination and counts', async () => {
    expect(
      await authoring.getWorkflow(workspaceId, workflowId, builder),
    ).toBeNull();
    expect(
      await authoring.getDraft(workspaceId, workflowId, builder),
    ).toBeNull();
    expect(
      (
        await authoring.listWorkflows({
          workspaceId,
          actorId: builder,
          limit: 1,
        })
      ).items.map(({ id }) => id),
    ).toEqual([publicId]);
    expect(
      (
        await organization.listWorkflows({
          workspaceId,
          actorId: builder,
          limit: 1,
        })
      ).items.map(({ workflow }) => workflow.id),
    ).toEqual([publicId]);
    expect(
      (await folders.listFolders({ workspaceId, actorId: builder })).items,
    ).toEqual([]);
    expect(
      await runs.get({ workspaceId, actorId: builder, runId: privateRun }),
    ).toBeUndefined();
    expect(
      await runs.readInput({
        workspaceId,
        actorId: builder,
        runId: privateRun,
      }),
    ).toBeUndefined();
    expect(
      await runs.canRead({ workspaceId, actorId: builder, runId: privateRun }),
    ).toBe(false);
    const page = await runs.list({ workspaceId, actorId: builder, limit: 1 });
    expect(page.items.map(({ id }) => id)).toEqual([publicRun]);
    expect(page.nextCursor).toBeUndefined();
    const statistics = await runs.statistics({
      workspaceId,
      actorId: builder,
      window: '24h',
      includeWorkflows: true,
    });
    expect(statistics.window.total).toBe(1);
    expect(statistics.window.byStatus.failed).toBe(0);
    expect(
      statistics.workflows?.items.map(({ workflowId }) => workflowId),
    ).toEqual([publicId]);
    const trends = await runs.usageTrends({
      workspaceId,
      actorId: builder,
      period: '30d',
      includeWorkflowNames: true,
    });
    expect(trends.total).toBe(1);
    expect(trends.busiest.map(({ workflowId }) => workflowId)).toEqual([
      publicId,
    ]);
  });

  it('allows a Viewer grant to read without granting authoring, and keeps the workspace ceiling', async () => {
    for (const user of [builder, viewer])
      await queryAsOwner(
        "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
        [randomUUID(), workspaceId, folderId, user],
        workspaceId,
      );
    try {
      expect(
        await authoring.getDraft(workspaceId, workflowId, builder),
      ).not.toBeNull();
      expect(
        (await authoring.getWorkflow(workspaceId, workflowId, builder))
          ?.resourceAccess,
      ).toEqual({ canEdit: false, canPublish: false });
      expect(
        (
          await organization.getWorkflow({
            workspaceId,
            workflowId,
            actorId: builder,
          })
        )?.workflow.resourceAccess,
      ).toEqual({ canEdit: false, canPublish: false });
      expect(
        (
          await folders.listFolders({ workspaceId, actorId: builder })
        ).items.find((folder) => folder.id === folderId)?.canCreateWorkflows,
      ).toBe(false);
      expect(
        await runs.canRead({ workspaceId, actorId: viewer, runId: privateRun }),
      ).toBe(true);
      await expect(
        authoring.renameWorkflow({
          workspaceId,
          actorId: builder,
          workflowId,
          name: 'Denied',
          expectedNameRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    } finally {
      await queryAsOwner(
        'delete from app.workflow_folder_grants where workspace_id=$1',
        [workspaceId],
        workspaceId,
      );
    }
  });
}
