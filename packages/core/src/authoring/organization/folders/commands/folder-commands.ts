import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';

import { requireMoveAudienceReview } from '../../sharing/audience.js';

import { runOrganizationCommand } from '../../run-command.js';

import { WorkflowFolderConflictError } from '../../workflow-organization.errors.js';

import type { createOrganizationSession } from '../../session.js';

import type {
  CreateFolderInput,
  DeleteFolderInput,
  MoveFolderInput,
  RenameFolderInput,
  WorkflowFolderCommandResult,
  WorkflowFolderDeleteResult,
} from '../workflow-folder.types.js';

import {
  folderDepth,
  readFolder,
  requireFreeName,
  requireRevision,
} from '../hierarchy.js';

import { deleteResult } from '../folder-receipts.schemas.js';
import { folderCommand } from './receipt.js';

import {
  countFolders,
  deleteFolderRow,
  folderInUse,
  insertFolder,
  moveFolderRow,
  readSubtree,
  renameFolderRow,
} from './mutations.repository.js';

export async function createFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: CreateFolderInput,
): Promise<WorkflowFolderCommandResult> {
  const request = {
    name: input.name,
    parentId: input.parentId,
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
      const folders = await countFolders(client, workspaceId);
      if (folders >= WORKFLOW_FOLDER_LIMITS.foldersPerWorkspace)
        throw new WorkflowFolderConflictError('limit');
      if (
        (await folderDepth(client, workspaceId, request.parentId)) + 1 >
        WORKFLOW_FOLDER_LIMITS.depth
      )
        throw new WorkflowFolderConflictError('hierarchy');
      const row = await insertFolder(client, workspaceId, request);
      return row;
    },
  });
}

export async function renameFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: RenameFolderInput,
): Promise<WorkflowFolderCommandResult> {
  const folderId = input.folderId;
  const request = {
    name: input.name,
    expectedFolderRevision: input.expectedFolderRevision,
  };
  return folderCommand(session, input, {
    operation: 'folder.rename',
    target: folderId,
    request,
    apply: async (client, workspaceId) => {
      const current = await readFolder(client, workspaceId, folderId);
      requireRevision(current, request.expectedFolderRevision);
      await requireFreeName(client, workspaceId, {
        parentId: current.parentId,
        folderName: request.name,
        folderId,
      });
      const renamed = await renameFolderRow(
        client,
        workspaceId,
        folderId,
        request.name,
      );
      return renamed ?? current;
    },
  });
}

export async function moveFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: MoveFolderInput,
): Promise<WorkflowFolderCommandResult> {
  const folderId = input.folderId;
  const request = {
    parentId: input.parentId,
    ...(input.audienceReview === undefined
      ? {}
      : {
          audienceReview: input.audienceReview,
        }),
    expectedFolderRevision: input.expectedFolderRevision,
  };
  return folderCommand(session, input, {
    operation: 'folder.move',
    target: folderId,
    request,
    apply: async (client, workspaceId, role) => {
      if (request.parentId !== null)
        await readFolder(client, workspaceId, request.parentId);
      await requireMoveAudienceReview(
        client,
        { workspaceId, actorId: input.actorId, role },
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
      const subtree = await readSubtree(
        client,
        workspaceId,
        folderId,
        request.parentId,
      );
      const { height = 1, cycle = false } = subtree;
      if (
        cycle ||
        height + (await folderDepth(client, workspaceId, request.parentId)) >
          WORKFLOW_FOLDER_LIMITS.depth
      )
        throw new WorkflowFolderConflictError('hierarchy');
      const moved = await moveFolderRow(
        client,
        workspaceId,
        folderId,
        request.parentId,
      );
      return moved ?? current;
    },
  });
}

export async function deleteFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: DeleteFolderInput,
): Promise<WorkflowFolderDeleteResult> {
  const folderId = input.folderId;
  const request = {
    expectedFolderRevision: input.expectedFolderRevision,
  };
  return session.command(input, 'governance:manage', async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      receipt: deleteResult,
      operation: 'folder.delete',
      target: folderId,
      idempotencyKey: input.idempotencyKey,
      request,
      apply: async () => {
        const current = await readFolder(client, scope.workspaceId, folderId);
        requireRevision(current, request.expectedFolderRevision);
        const used = await folderInUse(client, scope.workspaceId, folderId);
        if (used) throw new WorkflowFolderConflictError('not_empty');
        await deleteFolderRow(client, scope.workspaceId, folderId);
        return {
          result: { folderId, deleted: true as const },
          audit: { action: 'workflow.folder.delete', targetId: folderId },
        };
      },
    });
    return Object.freeze({ ...result, replayed });
  });
}
