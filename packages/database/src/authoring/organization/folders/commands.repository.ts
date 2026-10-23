import {
  ADMINISTRATIVE_ROLES,
  WORKFLOW_EDITOR_ROLES,
} from '@pertexo/workflow-model';
import { readSharingPrincipals } from '../../../tenant-access/resources/principals.js';

import { readFolderSharing, replaceFolderSharing } from '../sharing/grants.js';
import {
  requireMoveAudienceReview,
  reviewMoveAudience,
} from '../sharing/audience.js';
import { readFolderScope } from '../../../tenant-access/resources/facts.js';
import { FOLDER_LIMIT, FOLDER_DEPTH_LIMIT } from '../limits.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseConfig } from '../../../config.js';
import type { DatabaseRuntime } from '../../../platform/pool/runtime.js';
import { ROLES } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';

import { runOrganizationCommand } from '../command.js';
import { WorkflowFolderConflictError } from '../errors.js';
import {
  checkOrganizationReplay,
  organizeWorkflow,
} from '../organize-workflow.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from '../session.js';
import {
  type Command,
  type WorkflowFolderCommandResult,
  type WorkflowFolderDatabase,
  uuid,
  revision,
  name,
  folder,
  folderResult,
  deleteResult,
  placementResult,
  nameKey,
} from './contract.js';
import {
  type FolderRow,
  readFolder,
  folderDepth,
  requireFreeName,
  requireRevision,
  folderRecord,
} from './hierarchy.queries.js';
export {
  WorkflowFolderConflictError,
  type WorkflowFolderConflictKind,
} from '../errors.js';
export {
  type WorkflowFolderRecord,
  type WorkflowFolderCommandResult,
  type WorkflowFolderDeleteResult,
  type WorkflowFolderPlacementResult,
  type WorkflowFolderDatabase,
} from './contract.js';
const ADMINISTRATORS = ADMINISTRATIVE_ROLES;

const EDITORS = WORKFLOW_EDITOR_ROLES;

export function createWorkflowFolderDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowFolderDatabase {
  const session = createOrganizationSession(config, options.runtime);

  const store: WorkflowFolderDatabase = {
    sharingPrincipals: (input) => {
      return session.transact(input, (client, scope) =>
        readSharingPrincipals(client, scope, input.query),
      );
    },
    readSharing: (input) => {
      return session.transact(input, (client, scope) =>
        readFolderSharing(client, scope, uuid.parse(input.folderId)),
      );
    },
    replaceSharing: (input) => {
      return session.transact(input, (client, scope) =>
        replaceFolderSharing(client, scope, {
          ...input,
          folderId: uuid.parse(input.folderId),
        }),
      );
    },
    reviewMove: (input) => reviewFolderMove(session, input),
    listFolders: (input: OrganizationRequestScope) =>
      listFolders(session, input),

    createFolder: (input) => createFolder(session, input),

    renameFolder: (input) => renameFolder(session, input),

    moveFolder: (input) => moveFolder(session, input),

    deleteFolder: (input) => deleteFolder(session, input),

    placeWorkflow: (input) => placeWorkflow(session, input),

    close: session.close,
  };
  return Object.freeze(store);
}

function folderCommand(
  session: ReturnType<typeof createOrganizationSession>,
  input: Command,
  operation: string,
  target: string | null,
  request: unknown,
  apply: (client: PoolClient, workspaceId: string) => Promise<FolderRow>,
): Promise<WorkflowFolderCommandResult> {
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation,
      target,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: ADMINISTRATORS,
      apply: async () => {
        const row = await apply(client, scope.workspaceId);
        return {
          result: {
            folder: await folderRecord(client, scope.workspaceId, row),
          },
          audit: { action: `workflow.${operation}`, targetId: row.id },
        };
      },
    });
    return Object.freeze({ ...folderResult.parse(result), replayed });
  });
}

function reviewFolderMove(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['reviewMove']>[0],
): ReturnType<WorkflowFolderDatabase['reviewMove']> {
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(
      client,
      scope.workspaceId,
      scope.actorId,
      EDITORS,
    );
    return reviewMoveAudience(client, scope, input.request);
  });
}

function listFolders(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['listFolders']>[0],
): ReturnType<WorkflowFolderDatabase['listFolders']> {
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(
      client,
      scope.workspaceId,
      scope.actorId,
      ROLES,
    );
    // One statement derives the whole hierarchy. Count parity fails
    // closed for missing roots, cycles or excessive depth.
    const result = await client.query<{ items: unknown; total: number }>(
      `with recursive bounded as materialized (
          select id,name,parent_id,revision,access_mode from app.workflow_folders where workspace_id=$1 order by id limit 257
        ), tree as (
          select *,1 depth,array[id] path from bounded where parent_id is null
          union all select f.*,t.depth+1,t.path||f.id from bounded f join tree t on f.parent_id=t.id
            where t.depth<5 and not f.id=any(t.path)
        ) select (select count(*)::int from bounded) total,
          coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'parentId',parent_id,'revision',revision,'depth',depth,'accessMode',access_mode) order by id),'[]'::jsonb) items from tree`,
      [scope.workspaceId],
    );
    const row = result.rows[0];
    const access = await readFolderScope(client, scope);
    const items = z.array(folder).max(FOLDER_LIMIT).parse(row?.items);
    if (row?.total !== items.length)
      throw new Error('Workflow folder hierarchy is incompatible');
    return Object.freeze({
      items: Object.freeze(
        items
          .filter((item) => access.permits(item.id, 'workflow:read'))
          .map((item) =>
            Object.freeze({
              ...item,
              canCreateWorkflows: access.permits(item.id, 'workflow:create'),
            }),
          ),
      ),
    });
  });
}

async function createFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['createFolder']>[0],
): ReturnType<WorkflowFolderDatabase['createFolder']> {
  const request = {
    name: name.parse(input.name),
    parentId: uuid.nullable().parse(input.parentId),
  };
  return folderCommand(
    session,
    input,
    'folder.create',
    null,
    request,
    async (client, workspaceId) => {
      if (request.parentId !== null)
        await readFolder(client, workspaceId, request.parentId);
      await requireFreeName(
        client,
        workspaceId,
        request.parentId,
        request.name,
        null,
      );
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
  );
}

async function renameFolder(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['renameFolder']>[0],
): ReturnType<WorkflowFolderDatabase['renameFolder']> {
  const folderId = uuid.parse(input.folderId);
  const request = {
    name: name.parse(input.name),
    expectedFolderRevision: revision.parse(input.expectedFolderRevision),
  };
  return folderCommand(
    session,
    input,
    'folder.rename',
    folderId,
    request,
    async (client, workspaceId) => {
      const current = await readFolder(client, workspaceId, folderId);
      requireRevision(current, request.expectedFolderRevision);
      await requireFreeName(
        client,
        workspaceId,
        current.parent_id,
        request.name,
        folderId,
      );
      const renamed = await client.query<FolderRow>(
        `update app.workflow_folders
             set name = $3, name_key = $4, revision = revision + 1
             where workspace_id = $1 and id = $2
             returning id, name, parent_id, revision, access_mode`,
        [workspaceId, folderId, request.name, nameKey(request.name)],
      );
      return renamed.rows[0] ?? current;
    },
  );
}

async function moveFolder(
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
  return folderCommand(
    session,
    input,
    'folder.move',
    folderId,
    request,
    async (client, workspaceId) => {
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
      await requireFreeName(
        client,
        workspaceId,
        request.parentId,
        current.name,
        folderId,
      );
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
  );
}

async function deleteFolder(
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

async function placeWorkflow(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['placeWorkflow']>[0],
): ReturnType<WorkflowFolderDatabase['placeWorkflow']> {
  const workflowId = uuid.parse(input.workflowId);
  const request = {
    folderId: uuid.nullable().parse(input.folderId),
    ...(input.audienceReview === undefined
      ? {}
      : {
          audienceReview: input.audienceReview,
        }),
    expectedOrganizationRevision: revision.parse(
      input.expectedOrganizationRevision,
    ),
  };
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation: 'folder.place',
      target: workflowId,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: EDITORS,
      replay: () =>
        checkOrganizationReplay(
          client,
          scope,
          workflowId,
          'move',
          request.folderId,
        ),
      apply: async () => {
        const organizationRevision = await organizeWorkflow(client, scope, {
          workflowId,
          change: {
            kind: 'move',
            folderId: request.folderId,
            ...(request.audienceReview === undefined
              ? {}
              : { audienceReview: request.audienceReview }),
          },
          expectedOrganizationRevision: request.expectedOrganizationRevision,
        });
        return {
          result: {
            workflowId,
            organizationRevision,
            folderId: request.folderId,
          },
          audit: {
            action: 'workflow.organization.move',
            targetId: workflowId,
            metadata: {
              organizationRevision,
              audienceReviewed: request.audienceReview?.acknowledge === true,
            },
          },
        };
      },
    });
    return Object.freeze({ ...placementResult.parse(result), replayed });
  });
}
