import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias, unionAll } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowFolders,
  workflowOrganizationState,
} from '@pertexo/database/schema';
import { requireMoveAudienceReview } from '../../sharing/audience.queries.js';

import { FOLDER_DEPTH_LIMIT } from '../../limits.js';
import { FOLDER_LIMIT } from '../../../../shared/folder-policy.js';

import { runOrganizationCommand } from '../../commands.repository.js';
import { WorkflowFolderConflictError } from '../../errors.js';

import type { createOrganizationSession } from '../../session.js';
import type { WorkflowFolderDatabase } from '../contract.js';
import {
  folderDepth,
  folderProjection,
  readFolder,
  requireFreeName,
  requireRevision,
} from '../hierarchy.queries.js';
import { deleteResult, nameKey } from '../input.js';
import { ADMINISTRATORS, folderCommand } from './receipt.js';

export async function createFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['createFolder']>[0],
): ReturnType<WorkflowFolderDatabase['createFolder']> {
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
      const db = drizzle(client);
      const [count] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowFolders)
        .where(eq(workflowFolders.workspaceId, workspaceId))
        .catch(rethrowQueryFailure);
      if ((count?.count ?? 0) >= FOLDER_LIMIT)
        throw new WorkflowFolderConflictError('limit');
      if (
        (await folderDepth(client, workspaceId, request.parentId)) + 1 >
        FOLDER_DEPTH_LIMIT
      )
        throw new WorkflowFolderConflictError('hierarchy');
      const [row] = await db
        .insert(workflowFolders)
        .values({
          workspaceId,
          id: sql`uuidv7()`,
          parentId: request.parentId,
          name: request.name,
          nameKey: nameKey(request.name),
        })
        .returning(folderProjection)
        .catch(rethrowQueryFailure);
      if (row === undefined) throw new Error('Folder was not created');
      return row;
    },
  });
}

export async function renameFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['renameFolder']>[0],
): ReturnType<WorkflowFolderDatabase['renameFolder']> {
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
      const [renamed] = await drizzle(client)
        .update(workflowFolders)
        .set({
          name: request.name,
          nameKey: nameKey(request.name),
          revision: sql`${workflowFolders.revision}+1`,
        })
        .where(
          and(
            eq(workflowFolders.workspaceId, workspaceId),
            eq(workflowFolders.id, folderId),
          ),
        )
        .returning(folderProjection)
        .catch(rethrowQueryFailure);
      return renamed ?? current;
    },
  });
}

export async function moveFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['moveFolder']>[0],
): ReturnType<WorkflowFolderDatabase['moveFolder']> {
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
      const folder = alias(workflowFolders, 'folder');
      const subtree = await drizzle(client)
        .execute<{ height: number; cycle: boolean }>(
          sql`
        with recursive descendants as (
          select ${workflowFolders.id} id,1 height from ${workflowFolders}
          where ${workflowFolders.workspaceId}=${workspaceId} and ${workflowFolders.id}=${folderId}
          union all
          select ${folder.id},descendants.height+1 from descendants
          join ${workflowFolders} ${sql.identifier('folder')}
            on ${folder.workspaceId}=${workspaceId} and ${folder.parentId}=descendants.id
          where descendants.height<=${FOLDER_DEPTH_LIMIT}
        ) select max(height)::int height,coalesce(bool_or(id=${request.parentId}::uuid),false) cycle from descendants
      `,
        )
        .catch(rethrowQueryFailure);
      const { height = 1, cycle = false } = subtree.rows[0] ?? {};
      if (
        cycle ||
        height + (await folderDepth(client, workspaceId, request.parentId)) >
          FOLDER_DEPTH_LIMIT
      )
        throw new WorkflowFolderConflictError('hierarchy');
      const [moved] = await drizzle(client)
        .update(workflowFolders)
        .set({
          parentId: request.parentId,
          revision: sql`${workflowFolders.revision}+1`,
        })
        .where(
          and(
            eq(workflowFolders.workspaceId, workspaceId),
            eq(workflowFolders.id, folderId),
          ),
        )
        .returning(folderProjection)
        .catch(rethrowQueryFailure);
      return moved ?? current;
    },
  });
}

export async function deleteFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['deleteFolder']>[0],
): ReturnType<WorkflowFolderDatabase['deleteFolder']> {
  const folderId = input.folderId;
  const request = {
    expectedFolderRevision: input.expectedFolderRevision,
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
        const db = drizzle(client);
        const used = await unionAll(
          db
            .select({ id: workflowFolders.id })
            .from(workflowFolders)
            .where(
              and(
                eq(workflowFolders.workspaceId, scope.workspaceId),
                eq(workflowFolders.parentId, folderId),
              ),
            ),
          db
            .select({ id: workflowOrganizationState.workflowId })
            .from(workflowOrganizationState)
            .where(
              and(
                eq(workflowOrganizationState.workspaceId, scope.workspaceId),
                eq(workflowOrganizationState.folderId, folderId),
              ),
            ),
        )
          .limit(1)
          .catch(rethrowQueryFailure);
        if (used.length !== 0)
          throw new WorkflowFolderConflictError('not_empty');
        await db
          .delete(workflowFolders)
          .where(
            and(
              eq(workflowFolders.workspaceId, scope.workspaceId),
              eq(workflowFolders.id, folderId),
            ),
          )
          .catch(rethrowQueryFailure);
        return {
          result: { folderId, deleted: true },
          audit: { action: 'workflow.folder.delete', targetId: folderId },
        };
      },
    });
    return Object.freeze({ ...deleteResult.parse(result), replayed });
  });
}
