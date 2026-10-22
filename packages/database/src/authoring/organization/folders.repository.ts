import { readSharingPrincipals } from '../../tenant-access/resources/principals.js';
import type {
  SharingPrincipalsQuery,
  SharingPrincipals,
} from '@pertexo/contracts';
import {
  audienceReviewSchema,
  type AudienceReview,
  type FolderSharing,
  type FolderSharingRequest,
  type WorkflowMoveReviewRequest,
  type WorkflowMoveReview,
} from '@pertexo/contracts';
import { readFolderSharing, replaceFolderSharing } from './sharing/grants.js';
import {
  requireMoveAudienceReview,
  reviewMoveAudience,
} from './sharing/audience.js';
import { readFolderScope } from '../../tenant-access/resources/facts.js';
import { FOLDER_LIMIT, FOLDER_DEPTH_LIMIT } from './limits.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { ROLES } from '../../tenant-access/policy.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { runOrganizationCommand } from './command.js';
import { WorkflowFolderConflictError } from './errors.js';
import {
  checkOrganizationReplay,
  organizeWorkflow,
} from './organize-workflow.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from './session.js';

export {
  WorkflowFolderConflictError,
  type WorkflowFolderConflictKind,
} from './errors.js';

type Command = OrganizationRequestScope & Readonly<{ idempotencyKey: string }>;
type FolderCommand = Command &
  Readonly<{ folderId: string; expectedFolderRevision: number }>;
export type WorkflowFolderRecord = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
  depth: number;
  accessMode: 'workspace' | 'restricted';
  canCreateWorkflows?: boolean;
}>;
export type WorkflowFolderCommandResult = Readonly<{
  folder: WorkflowFolderRecord;
  replayed: boolean;
}>;
export type WorkflowFolderDeleteResult = Readonly<{
  folderId: string;
  deleted: true;
  replayed: boolean;
}>;
export type WorkflowFolderPlacementResult = Readonly<{
  workflowId: string;
  folderId: string | null;
  organizationRevision: number;
  replayed: boolean;
}>;
export interface WorkflowFolderDatabase {
  sharingPrincipals(
    input: OrganizationRequestScope & { query: SharingPrincipalsQuery },
  ): Promise<SharingPrincipals>;
  readSharing(
    input: OrganizationRequestScope & { folderId: string },
  ): Promise<FolderSharing>;
  replaceSharing(
    input: Command & { folderId: string; request: FolderSharingRequest },
  ): Promise<FolderSharing & { replayed: boolean }>;
  reviewMove(
    input: OrganizationRequestScope & { request: WorkflowMoveReviewRequest },
  ): Promise<WorkflowMoveReview>;
  listFolders(
    input: OrganizationRequestScope,
  ): Promise<Readonly<{ items: readonly WorkflowFolderRecord[] }>>;
  createFolder(
    input: Command & Readonly<{ name: string; parentId: string | null }>,
  ): Promise<WorkflowFolderCommandResult>;
  renameFolder(
    input: FolderCommand & Readonly<{ name: string }>,
  ): Promise<WorkflowFolderCommandResult>;
  moveFolder(
    input: FolderCommand &
      Readonly<{
        parentId: string | null;
        audienceReview?: AudienceReview | undefined;
      }>,
  ): Promise<WorkflowFolderCommandResult>;
  deleteFolder(input: FolderCommand): Promise<WorkflowFolderDeleteResult>;
  placeWorkflow(
    input: Command &
      Readonly<{
        workflowId: string;
        folderId: string | null;
        expectedOrganizationRevision: number;
        audienceReview?: AudienceReview | undefined;
      }>,
  ): Promise<WorkflowFolderPlacementResult>;
  close(): Promise<void>;
}

const ADMINISTRATORS = ['owner', 'admin'] as const;
const EDITORS = ['owner', 'admin', 'builder'] as const;

const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalName = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value === value.replace(/^ +| +$(?![\s\S])/gu, '') &&
      Buffer.byteLength(value, 'utf8') >= 1 &&
      Buffer.byteLength(value, 'utf8') <= 128 &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
const name = z
  .string()
  .overwrite((value) => value.replace(/^ +| +$(?![\s\S])/gu, ''))
  .pipe(canonicalName);
const folder = z
  .object({
    id: uuid,
    name: canonicalName,
    parentId: uuid.nullable(),
    revision,
    depth: z.number().int().min(1).max(FOLDER_DEPTH_LIMIT),
    accessMode: z.enum(['workspace', 'restricted']),
  })
  .strict()
  .refine((value) =>
    value.parentId === null ? value.depth === 1 : value.depth > 1,
  );
const folderResult = z.object({ folder }).strict();
const deleteResult = z
  .object({ folderId: uuid, deleted: z.literal(true) })
  .strict();
const placementResult = z
  .object({
    workflowId: uuid,
    folderId: uuid.nullable(),
    organizationRevision: revision,
  })
  .strict();

/** Sibling names are unique regardless of ASCII letter case. */
const nameKey = (value: string): string =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

type FolderRow = Readonly<{
  id: string;
  name: string;
  parent_id: string | null;
  revision: string;
  access_mode: 'workspace' | 'restricted';
}>;

async function readFolder(
  client: PoolClient,
  workspaceId: string,
  folderId: string,
): Promise<FolderRow> {
  const result = await client.query<FolderRow>(
    `select id, name, parent_id, revision, access_mode from app.workflow_folders
     where workspace_id = $1 and id = $2`,
    [workspaceId, folderId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Folder is not visible');
  return row;
}

/** How many folders deep a folder sits; a top-level folder is 1. */
async function folderDepth(
  client: PoolClient,
  workspaceId: string,
  folderId: string | null,
): Promise<number> {
  if (folderId === null) return 0;
  const result = await client.query<{
    depth: number | null;
    rooted: boolean | null;
  }>(
    `with recursive ancestors as (
       select parent_id, 1 depth from app.workflow_folders
       where workspace_id = $1 and id = $2
       union all
       select folder.parent_id, ancestors.depth + 1 from ancestors
       join app.workflow_folders folder
         on folder.workspace_id = $1 and folder.id = ancestors.parent_id
       where ancestors.depth <= $3
     )
     select max(depth)::int depth, bool_or(parent_id is null) rooted from ancestors`,
    [workspaceId, folderId, FOLDER_DEPTH_LIMIT],
  );
  const row = result.rows[0];
  if (
    row?.rooted !== true ||
    row.depth === null ||
    row.depth > FOLDER_DEPTH_LIMIT
  )
    throw new WorkflowFolderConflictError('hierarchy');
  return row.depth;
}

async function requireFreeName(
  client: PoolClient,
  workspaceId: string,
  parentId: string | null,
  folderName: string,
  folderId: string | null,
): Promise<void> {
  const taken = await client.query(
    `select 1 from app.workflow_folders
     where workspace_id = $1 and parent_id is not distinct from $2::uuid
       and name_key = $3 and id is distinct from $4::uuid`,
    [workspaceId, parentId, nameKey(folderName), folderId],
  );
  if (taken.rowCount !== 0) throw new WorkflowFolderConflictError('name');
}

function requireRevision(row: FolderRow, expected: number): void {
  if (Number(row.revision) !== expected)
    throw new WorkflowFolderConflictError('revision');
}

async function folderRecord(
  client: PoolClient,
  workspaceId: string,
  row: FolderRow,
): Promise<WorkflowFolderRecord> {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    revision: Number(row.revision),
    depth: await folderDepth(client, workspaceId, row.id),
    accessMode: row.access_mode,
  };
}

export function createWorkflowFolderDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowFolderDatabase {
  const session = createOrganizationSession(config, options.runtime);

  function folderCommand(
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

  const store: WorkflowFolderDatabase = {
    sharingPrincipals: (input) =>
      session.transact(input, (client, scope) =>
        readSharingPrincipals(client, scope, input.query),
      ),
    readSharing: (input) =>
      session.transact(input, (client, scope) =>
        readFolderSharing(client, scope, uuid.parse(input.folderId)),
      ),
    replaceSharing: (input) =>
      session.transact(input, (client, scope) =>
        replaceFolderSharing(client, scope, {
          ...input,
          folderId: uuid.parse(input.folderId),
        }),
      ),
    reviewMove: (input) =>
      session.transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          EDITORS,
        );
        return reviewMoveAudience(client, scope, input.request);
      }),
    listFolders: (input: OrganizationRequestScope) =>
      session.transact(input, async (client, scope) => {
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
                  canCreateWorkflows: access.permits(
                    item.id,
                    'workflow:create',
                  ),
                }),
              ),
          ),
        });
      }),

    createFolder: async (input) => {
      const request = {
        name: name.parse(input.name),
        parentId: uuid.nullable().parse(input.parentId),
      };
      return folderCommand(
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
            [
              workspaceId,
              request.parentId,
              request.name,
              nameKey(request.name),
            ],
          );
          const row = created.rows[0];
          if (row === undefined) throw new Error('Folder was not created');
          return row;
        },
      );
    },

    renameFolder: async (input) => {
      const folderId = uuid.parse(input.folderId);
      const request = {
        name: name.parse(input.name),
        expectedFolderRevision: revision.parse(input.expectedFolderRevision),
      };
      return folderCommand(
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
    },

    moveFolder: async (input) => {
      const folderId = uuid.parse(input.folderId);
      const request = {
        parentId: uuid.nullable().parse(input.parentId),
        ...(input.audienceReview === undefined
          ? {}
          : {
              audienceReview: audienceReviewSchema.parse(input.audienceReview),
            }),
        expectedFolderRevision: revision.parse(input.expectedFolderRevision),
      };
      return folderCommand(
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
            height +
              (await folderDepth(client, workspaceId, request.parentId)) >
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
    },

    deleteFolder: async (input) => {
      const folderId = uuid.parse(input.folderId);
      const request = {
        expectedFolderRevision: revision.parse(input.expectedFolderRevision),
      };
      return session.transact(input, async (client, scope) => {
        const { result, replayed } = await runOrganizationCommand(
          client,
          scope,
          {
            operation: 'folder.delete',
            target: folderId,
            idempotencyKey: input.idempotencyKey,
            request,
            roles: ADMINISTRATORS,
            apply: async () => {
              const current = await readFolder(
                client,
                scope.workspaceId,
                folderId,
              );
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
          },
        );
        return Object.freeze({ ...deleteResult.parse(result), replayed });
      });
    },

    placeWorkflow: async (input) => {
      const workflowId = uuid.parse(input.workflowId);
      const request = {
        folderId: uuid.nullable().parse(input.folderId),
        ...(input.audienceReview === undefined
          ? {}
          : {
              audienceReview: audienceReviewSchema.parse(input.audienceReview),
            }),
        expectedOrganizationRevision: revision.parse(
          input.expectedOrganizationRevision,
        ),
      };
      return session.transact(input, async (client, scope) => {
        const { result, replayed } = await runOrganizationCommand(
          client,
          scope,
          {
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
              const organizationRevision = await organizeWorkflow(
                client,
                scope,
                {
                  workflowId,
                  change: {
                    kind: 'move',
                    folderId: request.folderId,
                    ...(request.audienceReview === undefined
                      ? {}
                      : { audienceReview: request.audienceReview }),
                  },
                  expectedOrganizationRevision:
                    request.expectedOrganizationRevision,
                },
              );
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
                    audienceReviewed:
                      request.audienceReview?.acknowledge === true,
                  },
                },
              };
            },
          },
        );
        return Object.freeze({ ...placementResult.parse(result), replayed });
      });
    },

    close: session.close,
  };
  return Object.freeze(store);
}
