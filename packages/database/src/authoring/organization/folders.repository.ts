import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseConfig } from '../../config.js';
import type { DatabaseRuntime } from '../../platform/database-runtime.js';
import { ROLES } from '../../tenant-access/workspace-policy.js';
import { lockWorkflowAuthoringAuthority } from '../workflow-authoring-authority.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from '../workflow-authoring-errors.js';
import {
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
} from './errors.js';
import { WorkflowTagConflictError } from './tags.repository.js';
import { createOrganizationDatabaseSession } from './session.js';

type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
type Command = Scope & Readonly<{ idempotencyKey: string }>;
type FolderCommand = Command &
  Readonly<{ folderId: string; expectedFolderRevision: number }>;
export type WorkflowFolderRecord = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
  depth: number;
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
  listFolders(
    input: Scope,
  ): Promise<Readonly<{ items: readonly WorkflowFolderRecord[] }>>;
  createFolder(
    input: Command & Readonly<{ name: string; parentId: string | null }>,
  ): Promise<WorkflowFolderCommandResult>;
  renameFolder(
    input: FolderCommand & Readonly<{ name: string }>,
  ): Promise<WorkflowFolderCommandResult>;
  moveFolder(
    input: FolderCommand & Readonly<{ parentId: string | null }>,
  ): Promise<WorkflowFolderCommandResult>;
  deleteFolder(input: FolderCommand): Promise<WorkflowFolderDeleteResult>;
  placeWorkflow(
    input: Command &
      Readonly<{
        workflowId: string;
        folderId: string | null;
        expectedOrganizationRevision: number;
      }>,
  ): Promise<WorkflowFolderPlacementResult>;
  close(): Promise<void>;
}
export type WorkflowFolderConflictKind =
  'name' | 'limit' | 'revision' | 'hierarchy' | 'not_empty' | 'not_visible';
export class WorkflowFolderConflictError extends Error {
  override readonly name = 'WorkflowFolderConflictError';
  constructor(readonly kind: WorkflowFolderConflictKind) {
    super('Workflow folder command conflicts');
  }
}
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
    depth: z.number().int().min(1).max(4),
  })
  .strict()
  .refine((value) =>
    value.parentId === null ? value.depth === 1 : value.depth > 1,
  );
const commandResult = z.object({ folder, replayed: z.boolean() }).strict();
const deleteResult = z
  .object({ folderId: uuid, deleted: z.literal(true), replayed: z.boolean() })
  .strict();
const placementResult = z
  .object({
    workflowId: uuid,
    folderId: uuid.nullable(),
    organizationRevision: revision,
    replayed: z.boolean(),
  })
  .strict();
const scopeSchema = z.object({
  workspaceId: uuid,
  actorId: uuid,
  signal: z.instanceof(AbortSignal).optional(),
});
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$(?![\s\S])/u)
  .refine((value) => !value.includes(','));
function digest(input: Command) {
  return createHash('sha256')
    .update(key.parse(input.idempotencyKey))
    .digest('hex');
}

/** Internal shared SQL error translation for the folder/batch adapter leaves. */
export function workflowFolderDatabaseFailure(error: unknown): never {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  if (!parsed.success) throw error;
  const kinds: Readonly<Record<string, WorkflowFolderConflictKind>> = {
    P7011: 'name',
    P7012: 'limit',
    P7013: 'revision',
    P7014: 'hierarchy',
    P7015: 'not_empty',
    P7016: 'not_visible',
  };
  const kind = kinds[parsed.data.code];
  if (kind !== undefined) throw new WorkflowFolderConflictError(kind);
  switch (parsed.data.code) {
    case 'P7008':
      throw new WorkflowTagConflictError('organization_revision');
    case 'P7009':
      throw new WorkflowTagConflictError('lifecycle');
    case '42501':
      throw new WorkflowNotFoundError('Workflow is not visible');
    case 'P7001':
      throw new WorkflowOrganizationUnavailableError();
    case 'P7002':
      throw new WorkflowIdempotencyConflictError(
        'Idempotency key request mismatch',
      );
    case '22023':
      throw new WorkflowOrganizationValidationError();
    default:
      throw error;
  }
}

export function createWorkflowFolderDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowFolderDatabase {
  const { transact, close } = createOrganizationDatabaseSession(
    config,
    options.runtime,
    (input) => {
      const { signal, ...ids } = scopeSchema.parse(input);
      return signal === undefined ? ids : { ...ids, signal };
    },
    workflowFolderDatabaseFailure,
  );
  async function command<T>(
    input: Command,
    operation: string,
    target: string | null,
    body: object,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const hash = digest(input);
    return transact(input, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'select app.execute_workflow_folder_command($1,$2,$3,$4::jsonb) result',
        [operation, target, hash, JSON.stringify(body)],
      );
      const value = schema.parse(result.rows[0]?.result);
      return Object.freeze(value);
    });
  }
  return Object.freeze({
    async listFolders(input: Scope) {
      return transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          ROLES,
        );
        // One bounded statement snapshot derives the hierarchy under tenant RLS.
        // Count parity fails closed for missing roots, cycles or excessive depth.
        const result = await client.query<{ items: unknown; total: number }>(
          `with recursive bounded as materialized (
          select id,name,parent_id,revision from app.workflow_folders where workspace_id=$1 order by id limit 257
        ), tree as (
          select *,1 depth,array[id] path from bounded where parent_id is null
          union all select f.*,t.depth+1,t.path||f.id from bounded f join tree t on f.parent_id=t.id
            where t.depth<5 and not f.id=any(t.path)
        ) select (select count(*)::int from bounded) total,
          coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'parentId',parent_id,'revision',revision,'depth',depth) order by id),'[]'::jsonb) items from tree`,
          [scope.workspaceId],
        );
        const row = result.rows[0];
        const items = z.array(folder).max(256).parse(row?.items);
        if (row?.total !== items.length)
          throw new Error('Workflow folder hierarchy is incompatible');
        if (
          !items.every(
            (item, index) =>
              index === 0 || (items[index - 1]?.id ?? '') < item.id,
          )
        )
          throw new Error('Workflow folder order is incompatible');
        return Object.freeze({
          items: Object.freeze(items.map((item) => Object.freeze(item))),
        });
      });
    },
    createFolder: (
      input: Command & Readonly<{ name: string; parentId: string | null }>,
    ) =>
      command(
        input,
        'folder.create',
        null,
        {
          name: name.parse(input.name),
          parentId: uuid.nullable().parse(input.parentId),
        },
        commandResult,
      ),
    renameFolder: (input: FolderCommand & Readonly<{ name: string }>) =>
      command(
        input,
        'folder.rename',
        uuid.parse(input.folderId),
        {
          name: name.parse(input.name),
          expectedFolderRevision: revision.parse(input.expectedFolderRevision),
        },
        commandResult,
      ),
    moveFolder: (
      input: FolderCommand & Readonly<{ parentId: string | null }>,
    ) =>
      command(
        input,
        'folder.move',
        uuid.parse(input.folderId),
        {
          parentId: uuid.nullable().parse(input.parentId),
          expectedFolderRevision: revision.parse(input.expectedFolderRevision),
        },
        commandResult,
      ),
    deleteFolder: (input: FolderCommand) =>
      command(
        input,
        'folder.delete',
        uuid.parse(input.folderId),
        {
          expectedFolderRevision: revision.parse(input.expectedFolderRevision),
        },
        deleteResult,
      ),
    async placeWorkflow(
      input: Command &
        Readonly<{
          workflowId: string;
          folderId: string | null;
          expectedOrganizationRevision: number;
        }>,
    ) {
      const workflowId = uuid.parse(input.workflowId),
        hash = digest(input);
      const body = {
        folderId: uuid.nullable().parse(input.folderId),
        expectedOrganizationRevision: revision.parse(
          input.expectedOrganizationRevision,
        ),
      };
      return transact(input, async (client) => {
        const result = await client.query<{ result: unknown }>(
          'select app.execute_workflow_folder_placement($1,$2,$3::jsonb) result',
          [workflowId, hash, JSON.stringify(body)],
        );
        return Object.freeze(placementResult.parse(result.rows[0]?.result));
      });
    },
    close,
  });
}
