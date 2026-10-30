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
import { builder, privateRun, publicRun, folders, runs } from './fixture.js';

export function registerKeepsRetainedRunReadsAvailable(): void {
  it('keeps retained run reads available in inactive workspaces without widening folder grants or writes', async () => {
    try {
      for (const status of ['suspended', 'pending_deletion']) {
        await queryAsOwner(
          `update app.workspaces set status=$2::text,
          deletion_requested_at=case when $2::text='pending_deletion' then clock_timestamp() end,
          deletion_requested_by=case when $2::text='pending_deletion' then $3::uuid end,
          deletion_reason=case when $2::text='pending_deletion' then 'retained-read proof' end,
          purge_after=case when $2::text='pending_deletion' then clock_timestamp()+interval '1 day' end
          where id=$1`,
          [workspaceId, status, actorId],
          workspaceId,
        );
        expect(
          await runs.canRead({ workspaceId, actorId, runId: privateRun }),
        ).toBe(true);
        expect(
          await runs.canRead({
            workspaceId,
            actorId: builder,
            runId: privateRun,
          }),
        ).toBe(false);
        expect(
          await runs.canRead({
            workspaceId,
            actorId: builder,
            runId: publicRun,
          }),
        ).toBe(true);
        await expect(
          authoring.createWorkflow({
            workspaceId,
            actorId: builder,
            name: 'Inactive write',
            emptyGraph,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      }
    } finally {
      await queryAsOwner(
        "update app.workspaces set status='active',deletion_requested_at=null,deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1",
        [workspaceId],
        workspaceId,
      );
    }
  });

  it('serializes a grant removal against authoring and refuses even an exact old command after revocation', async () => {
    const folder = (
      await folders.createFolder({
        workspaceId,
        actorId,
        name: 'Concurrent sharing',
        parentId: null,
        idempotencyKey: randomUUID(),
      })
    ).folder;
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Concurrent authoring',
      emptyGraph,
      folderId: folder.id,
      idempotencyKey: randomUUID(),
    });
    await folders.replaceSharing({
      workspaceId,
      actorId,
      folderId: folder.id,
      idempotencyKey: randomUUID(),
      request: {
        mode: 'restricted',
        expectedFolderRevision: 1,
        grants: [{ kind: 'member', userId: builder, access: 'editor' }],
      },
    });
    const command = {
      workspaceId,
      actorId: builder,
      workflowId: created.workflowId,
      name: 'Accepted before revocation',
      expectedNameRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const [write, revoke] = await Promise.allSettled([
      authoring.renameWorkflow(command),
      folders.replaceSharing({
        workspaceId,
        actorId,
        folderId: folder.id,
        idempotencyKey: randomUUID(),
        request: { mode: 'restricted', expectedFolderRevision: 2, grants: [] },
      }),
    ]);
    expect(revoke.status).toBe('fulfilled');
    if (write.status === 'rejected')
      expect(write.reason).toBeInstanceOf(WorkflowNotFoundError);
    expect(
      await authoring.getWorkflow(workspaceId, created.workflowId, builder),
    ).toBeNull();
    await expect(authoring.renameWorkflow(command)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    const current = await authoring.getWorkflow(
      workspaceId,
      created.workflowId,
      actorId,
    );
    expect(current?.name).toBe(
      write.status === 'fulfilled' ? command.name : 'Concurrent authoring',
    );
  });
}
