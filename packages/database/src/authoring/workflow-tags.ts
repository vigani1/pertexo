import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';
import { ROLES } from '../tenant-access/workspace-policy.js';
import { lockWorkflowAuthoringAuthority } from './workflow-authoring-authority.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';
import {
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
} from './workflow-organization-errors.js';

type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
type Command = Scope & Readonly<{ idempotencyKey: string }>;
type PageInput = Scope & Readonly<{ limit?: number; afterId?: string }>;
type TaggedCommand = Command &
  Readonly<{ tagId: string; expectedTagRevision: number }>;
type AssignmentCommand = Command &
  Readonly<{ workflowId: string; expectedOrganizationRevision: number }>;
export type WorkflowTagRecord = Readonly<{
  id: string;
  key: string;
  revision: number;
}>;
export type WorkflowTagAssignment = Readonly<{
  workflowId: string;
  organizationRevision: number;
}>;
type Page<T> = Readonly<{ items: readonly T[]; nextId: string | null }>;
export type WorkflowTagCommandResult = Readonly<{
  tag: WorkflowTagRecord;
  replayed: boolean;
}>;
export type WorkflowTagDeleteResult = Readonly<{
  tagId: string;
  deleted: true;
  detachedWorkflowCount: number;
  replayed: boolean;
}>;
export type WorkflowTagAssignmentResult = WorkflowTagAssignment &
  Readonly<{ replayed: boolean }>;
export type WorkflowTagReplaceResult = WorkflowTagAssignmentResult &
  Readonly<{ tagIds: readonly string[] }>;

/** Hides canonical command identity, current authority and receipt recovery.
 * Page positions are internal UUIDs; signed wire continuations belong to API. */
export interface WorkflowTagDatabase {
  listTags(input: PageInput): Promise<Page<WorkflowTagRecord>>;
  listTagAssignments(
    input: PageInput & Readonly<{ tagId: string }>,
  ): Promise<Page<WorkflowTagAssignment>>;
  createTag(
    input: Command & Readonly<{ key: string }>,
  ): Promise<WorkflowTagCommandResult>;
  renameTag(
    input: TaggedCommand & Readonly<{ key: string }>,
  ): Promise<WorkflowTagCommandResult>;
  deleteTag(input: TaggedCommand): Promise<WorkflowTagDeleteResult>;
  replaceTags(
    input: AssignmentCommand & Readonly<{ tagIds: readonly string[] }>,
  ): Promise<WorkflowTagReplaceResult>;
  detachTag(
    input: AssignmentCommand & Readonly<{ tagId: string }>,
  ): Promise<WorkflowTagAssignmentResult>;
  close(): Promise<void>;
}
export type WorkflowTagConflictKind =
  | 'key'
  | 'limit'
  | 'tag_revision'
  | 'delete_overflow'
  | 'organization_revision'
  | 'lifecycle';
export class WorkflowTagConflictError extends Error {
  override readonly name = 'WorkflowTagConflictError';
  constructor(readonly kind: WorkflowTagConflictKind) {
    super('Workflow organization command conflicts');
  }
}
const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalKey = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u);
const key = z
  .string()
  .overwrite((value) =>
    value
      .replace(/^ +| +$(?![\s\S])/gu, '')
      .replace(/[A-Z]/gu, (letter) => letter.toLowerCase()),
  )
  .pipe(canonicalKey);
const tag = z.object({ id: uuid, key: canonicalKey, revision }).strict();
const assignment = z
  .object({ workflowId: uuid, organizationRevision: revision })
  .strict();
const tagResult = z.object({ tag, replayed: z.boolean() }).strict();
const deleteResult = z
  .object({
    tagId: uuid,
    deleted: z.literal(true),
    detachedWorkflowCount: z.number().int().min(0).max(50),
    replayed: z.boolean(),
  })
  .strict();
const assignmentResult = assignment.extend({ replayed: z.boolean() }).strict();
const tagIds = z
  .array(uuid)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length)
  .overwrite((ids) => [...ids].sort());
const replaceResult = assignmentResult.extend({ tagIds }).strict();
const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$(?![\s\S])/u)
  .refine((value) => !value.includes(','));
const scopeSchema = z.object({
  workspaceId: uuid,
  actorId: uuid,
  signal: z.instanceof(AbortSignal).optional(),
});
function parseScope(input: Scope): Scope {
  const { signal, ...scope } = scopeSchema.parse(input);
  return signal === undefined ? scope : { ...scope, signal };
}
function page(input: PageInput) {
  return {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 50),
    after: input.afterId === undefined ? null : uuid.parse(input.afterId),
  };
}
function digest(input: Command): string {
  return createHash('sha256')
    .update(idempotencyKey.parse(input.idempotencyKey))
    .digest('hex');
}
function failure(error: unknown): never {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  if (!parsed.success) throw error;
  const conflicts: Readonly<Record<string, WorkflowTagConflictKind>> = {
    P7003: 'key',
    P7004: 'limit',
    P7006: 'tag_revision',
    P7007: 'delete_overflow',
    P7008: 'organization_revision',
    P7009: 'lifecycle',
  };
  const conflict = conflicts[parsed.data.code];
  if (conflict !== undefined) throw new WorkflowTagConflictError(conflict);
  switch (parsed.data.code) {
    case '42501':
    case 'P7005':
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
function pagination<T>(
  rows: readonly T[],
  limit: number,
  lastId: (item: T) => string,
): Page<T> {
  const items = rows.slice(0, limit).map((item) => Object.freeze(item));
  const last = items.at(-1);
  return Object.freeze({
    items: Object.freeze(items),
    nextId: rows.length > limit && last !== undefined ? lastId(last) : null,
  });
}

export function createWorkflowTagDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowTagDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  async function transact<T>(
    input: Scope,
    work: (client: PoolClient, scope: Scope) => Promise<T>,
  ): Promise<T> {
    const scope = parseScope(input);
    try {
      return await withTenantScopedClient(
        lease.pool,
        scope,
        (client) => work(client, scope),
        scope.signal === undefined ? {} : { signal: scope.signal },
      );
    } catch (error: unknown) {
      return failure(error);
    }
  }
  async function tagCommand<T>(
    input: Command,
    operation: string,
    target: string | null,
    body: object,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const hash = digest(input);
    return transact(input, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'select app.execute_workflow_tag_command($1,$2,$3,$4::jsonb) result',
        [operation, target, hash, JSON.stringify(body)],
      );
      return Object.freeze(schema.parse(result.rows[0]?.result));
    });
  }
  async function assignmentCommand<T>(
    input: AssignmentCommand,
    operation: string,
    body: object,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const target = uuid.parse(input.workflowId),
      hash = digest(input);
    return transact(input, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'select app.execute_workflow_tag_assignment_command($1,$2,$3,$4::jsonb) result',
        [operation, target, hash, JSON.stringify(body)],
      );
      return Object.freeze(schema.parse(result.rows[0]?.result));
    });
  }
  const store: WorkflowTagDatabase = {
    async listTags(input) {
      const { limit, after } = page(input);
      return transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          ROLES,
        );
        const rows = await client.query<{ tag: unknown }>(
          `select jsonb_build_object('id',id,'key',key,'revision',revision) tag from app.workflow_tags where workspace_id=$1 ${after === null ? '' : 'and id>$2::uuid'} order by id asc limit ${after === null ? '$2' : '$3'}`,
          after === null
            ? [scope.workspaceId, limit + 1]
            : [scope.workspaceId, after, limit + 1],
        );
        return pagination(
          rows.rows.map((row) => tag.parse(row.tag)),
          limit,
          (item) => item.id,
        );
      });
    },
    async listTagAssignments(input) {
      const { limit, after } = page(input),
        tagId = uuid.parse(input.tagId);
      return transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          ['owner', 'admin'],
        );
        // Tag visibility and bounded assignment rows share one statement
        // snapshot. No tag write privilege or privileged reader helper is needed.
        const result = await client.query<{ visible: boolean; items: unknown }>(
          `select exists(select 1 from app.workflow_tags where workspace_id=$1 and id=$2) visible,
          coalesce((select jsonb_agg(page.item order by page.workflow_id) from (
          select a.workflow_id,jsonb_build_object('workflowId',a.workflow_id,'organizationRevision',coalesce(s.revision,1)) item
          from app.workflow_tag_assignments a join app.workflows w on w.workspace_id=a.workspace_id and w.id=a.workflow_id
          left join app.workflow_organization_state s on s.workspace_id=a.workspace_id and s.workflow_id=a.workflow_id
          where a.workspace_id=$1 and a.tag_id=$2 ${after === null ? '' : 'and a.workflow_id>$3::uuid'}
          order by a.workflow_id asc limit ${after === null ? '$3' : '$4'}) page),'[]'::jsonb) items`,
          after === null
            ? [scope.workspaceId, tagId, limit + 1]
            : [scope.workspaceId, tagId, after, limit + 1],
        );
        const row = result.rows[0];
        if (row?.visible !== true)
          throw new WorkflowNotFoundError('Workflow is not visible');
        return pagination(
          z
            .array(assignment)
            .max(limit + 1)
            .parse(row.items),
          limit,
          (item) => item.workflowId,
        );
      });
    },
    createTag: (input) =>
      tagCommand(
        input,
        'tag.create',
        null,
        { key: key.parse(input.key) },
        tagResult,
      ),
    renameTag: (input) =>
      tagCommand(
        input,
        'tag.rename',
        uuid.parse(input.tagId),
        {
          key: key.parse(input.key),
          expectedTagRevision: revision.parse(input.expectedTagRevision),
        },
        tagResult,
      ),
    deleteTag: (input) =>
      tagCommand(
        input,
        'tag.delete',
        uuid.parse(input.tagId),
        { expectedTagRevision: revision.parse(input.expectedTagRevision) },
        deleteResult,
      ),
    replaceTags: (input) =>
      assignmentCommand(
        input,
        'tags.replace',
        {
          tagIds: tagIds.parse(input.tagIds),
          expectedOrganizationRevision: revision.parse(
            input.expectedOrganizationRevision,
          ),
        },
        replaceResult,
      ),
    detachTag: (input) =>
      assignmentCommand(
        input,
        'tag.detach',
        {
          tagId: uuid.parse(input.tagId),
          expectedOrganizationRevision: revision.parse(
            input.expectedOrganizationRevision,
          ),
        },
        assignmentResult,
      ),
    close: lease.close,
  };
  return Object.freeze(store);
}
