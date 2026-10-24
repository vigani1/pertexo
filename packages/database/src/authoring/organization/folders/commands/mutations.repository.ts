import { requireMoveAudienceReview } from '../../sharing/audience.queries.js';

import { FOLDER_LIMIT, FOLDER_DEPTH_LIMIT } from '../../limits.js';

import { runOrganizationCommand } from '../../commands.repository.js';
import { WorkflowFolderConflictError } from '../../errors.js';

import type { createOrganizationSession } from '../../session.js';
import {
  type WorkflowFolderDatabase,
  uuid,
  revision,
  name,
  deleteResult,
  nameKey,
} from '../contract.js';
import {
  type FolderRow,
  readFolder,
  folderDepth,
  requireFreeName,
  requireRevision,
} from '../hierarchy.queries.js';
import { ADMINISTRATORS, folderCommand } from './receipt.js';

export async function createFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['createFolder']>[0],
): ReturnType<WorkflowFolderDatabase['createFolder']> {
  const request = {
    name: name.parse(input.name),
    parentId: uuid.nullable().parse(input.parentId),
  };
  return folderCommand(session, input, {
    operation: 'folder.create',
    target: null,
    request,
    apply: async (client, workspaceId) => {
      if (request.parentId !== null)
        await readFolder(client, workspaceId, request.parentId);
      await requireFreeName(client, workspaceId, {
        parentId: request.parentId,
        folderName: request.name,
        folderId: null,
      });
      const count = await client.query<{ count: number }>(
        'select count(*)::int count from app.workflow_folders where workspace_id = $1',
        [workspaceId],
      );
      if ((count.rows[0]?.count ?? 0) >= FOLDER_LIMIT)
        throw new WorkflowFolderConflictError('limit');
      if (
        (await folderDepth(client, workspaceId, request.parentId)) + 1 >
        FOLDER_DEPTH_LIMIT
      )
        throw new WorkflowFolderConflictError('hierarchy');
      const created = await client.query<FolderRow>(
        `insert into app.workflow_folders (workspace_id, id, parent_id, name, name_key)
             values ($1, uuidv7(), $2, $3, $4)
             returning id, name, parent_id, revision, access_mode`,
        [workspaceId, request.parentId, request.name, nameKey(request.name)],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error('Folder was not created');
      return row;
    },
  });
}

export async function renameFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['renameFolder']>[0],
): ReturnType<WorkflowFolderDatabase['renameFolder']> {
  const folderId = uuid.parse(input.folderId);
  const request = {
    name: name.parse(input.name),
    expectedFolderRevision: revision.parse(input.expectedFolderRevision),
  };
  return folderCommand(session, input, {
    operation: 'folder.rename',
    target: folderId,
    request,
    apply: async (client, workspaceId) => {
      const current = await readFolder(client, workspaceId, folderId);
      requireRevision(current, request.expectedFolderRevision);
      await requireFreeName(client, workspaceId, {
        parentId: current.parent_id,
        folderName: request.name,
        folderId,
      });
      const renamed = await client.query<FolderRow>(
        `update app.workflow_folders
             set name = $3, name_key = $4, revision = revision + 1
             where workspace_id = $1 and id = $2
             returning id, name, parent_id, revision, access_mode`,
        [workspaceId, folderId, request.name, nameKey(request.name)],
      );
      return renamed.rows[0] ?? current;
    },
  });
}

export async function moveFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['moveFolder']>[0],
): ReturnType<WorkflowFolderDatabase['moveFolder']> {
  const folderId = uuid.parse(input.folderId);
  const request = {
    parentId: uuid.nullable().parse(input.parentId),
    ...(input.audienceReview === undefined
      ? {}
      : {
          audienceReview: input.audienceReview,
        }),
    expectedFolderRevision: revision.parse(input.expectedFolderRevision),
  };
  return folderCommand(session, input, {
    operation: 'folder.move',
    target: folderId,
    request,
    apply: async (client, workspaceId) => {
      if (request.parentId !== null)
        await readFolder(client, workspaceId, request.parentId);
      await requireMoveAudienceReview(
        client,
        { workspaceId, actorId: input.actorId },
        { kind: 'folder', folderId, destinationFolderId: request.parentId },
        request.audienceReview,
      );
      const current = await readFolder(client, workspaceId, folderId);
      requireRevision(current, request.expectedFolderRevision);
      await requireFreeName(client, workspaceId, {
        parentId: request.parentId,
        folderName: current.name,
        folderId,
      });
      // The moved folder and everything under it must stay within the
      // depth limit, and it cannot move under itself.
      const subtree = await client.query<{
        height: number;
        cycle: boolean;
      }>(
        `with recursive descendants as (
               select id, 1 height from app.workflow_folders
               where workspace_id = $1 and id = $2
               union all
               select folder.id, descendants.height + 1 from descendants
               join app.workflow_folders folder
                 on folder.workspace_id = $1 and folder.parent_id = descendants.id
               where descendants.height <= $4
             )
             select max(height)::int height,
                    coalesce(bool_or(id = $3::uuid), false) cycle
             from descendants`,
        [workspaceId, folderId, request.parentId, FOLDER_DEPTH_LIMIT],
      );
      const { height = 1, cycle = false } = subtree.rows[0] ?? {};
      if (
        cycle ||
        height + (await folderDepth(client, workspaceId, request.parentId)) >
          FOLDER_DEPTH_LIMIT
      )
        throw new WorkflowFolderConflictError('hierarchy');
      const moved = await client.query<FolderRow>(
        `update app.workflow_folders
             set parent_id = $3, revision = revision + 1
             where workspace_id = $1 and id = $2
             returning id, name, parent_id, revision, access_mode`,
        [workspaceId, folderId, request.parentId],
      );
      return moved.rows[0] ?? current;
    },
  });
}

export async function deleteFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['deleteFolder']>[0],
): ReturnType<WorkflowFolderDatabase['deleteFolder']> {
  const folderId = uuid.parse(input.folderId);
  const request = {
    expectedFolderRevision: revision.parse(input.expectedFolderRevision),
  };
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation: 'folder.delete',
      target: folderId,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: ADMINISTRATORS,
      apply: async () => {
        const current = await readFolder(client, scope.workspaceId, folderId);
        requireRevision(current, request.expectedFolderRevision);
        const used = await client.query(
          `select 1 from app.workflow_folders where workspace_id = $1 and parent_id = $2
                 union all
                 select 1 from app.workflow_organization_state
                 where workspace_id = $1 and folder_id = $2
                 limit 1`,
          [scope.workspaceId, folderId],
        );
        if (used.rowCount !== 0)
          throw new WorkflowFolderConflictError('not_empty');
        await client.query(
          'delete from app.workflow_folders where workspace_id = $1 and id = $2',
          [scope.workspaceId, folderId],
        );
        return {
          result: { folderId, deleted: true },
          audit: { action: 'workflow.folder.delete', targetId: folderId },
        };
      },
    });
    return Object.freeze({ ...deleteResult.parse(result), replayed });
  });
}
