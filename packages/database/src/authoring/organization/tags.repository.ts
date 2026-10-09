import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { ROLES } from '../../tenant-access/policy.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { runOrganizationCommand, type OrganizationScope } from './command.js';
import { WorkflowTagConflictError } from './errors.js';
import {
  checkOrganizationReplay,
  organizeWorkflow,
  type OrganizationChange,
} from './organize-workflow.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from './session.js';

export {
  WorkflowTagConflictError,
  type WorkflowTagConflictKind,
} from './errors.js';

type Command = OrganizationRequestScope & Readonly<{ idempotencyKey: string }>;
type PageInput = OrganizationRequestScope &
  Readonly<{ limit?: number; afterId?: string }>;
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

/** Tags, their workflows and tag commands. Page positions are tag and
 * workflow UUIDs; signed wire continuations belong to the API. */
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

const TAG_LIMIT = 256;
/** A tag on more workflows is detached through bounded cleanup first. */
const TAG_DELETE_WORKFLOW_LIMIT = 50;
const ADMINISTRATORS = ['owner', 'admin'] as const;
const EDITORS = ['owner', 'admin', 'builder'] as const;

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
const tagResult = z.object({ tag }).strict();
const deleteResult = z
  .object({
    tagId: uuid,
    deleted: z.literal(true),
    detachedWorkflowCount: z
      .number()
      .int()
      .min(0)
      .max(TAG_DELETE_WORKFLOW_LIMIT),
  })
  .strict();
const tagIds = z
  .array(uuid)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length)
  .overwrite((ids) => [...ids].sort());
const replaceResult = assignment.extend({ tagIds }).strict();

type TagRow = Readonly<{ id: string; key: string; revision: string }>;

const tagRecord = (row: TagRow): WorkflowTagRecord => ({
  id: row.id,
  key: row.key,
  revision: Number(row.revision),
});

async function readTag(
  client: PoolClient,
  workspaceId: string,
  tagId: string,
): Promise<TagRow> {
  const result = await client.query<TagRow>(
    'select id, key, revision from app.workflow_tags where workspace_id = $1 and id = $2',
    [workspaceId, tagId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new WorkflowNotFoundError('Tag is not visible');
  return row;
}

async function requireFreeKey(
  client: PoolClient,
  workspaceId: string,
  tagKey: string,
  tagId: string | null,
): Promise<void> {
  const taken = await client.query(
    `select 1 from app.workflow_tags
     where workspace_id = $1 and key = $2 and id is distinct from $3::uuid`,
    [workspaceId, tagKey, tagId],
  );
  if (taken.rowCount !== 0) throw new WorkflowTagConflictError('key');
}

function requireRevision(row: TagRow, expected: number): void {
  if (Number(row.revision) !== expected)
    throw new WorkflowTagConflictError('tag_revision');
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

/** Detaches a tag from at most 50 workflows, advancing each one's revision. */
async function deleteTag(
  client: PoolClient,
  scope: OrganizationScope,
  tagId: string,
): Promise<number> {
  const assigned = await client.query<{ workflow_id: string }>(
    `select workflow_id from app.workflow_tag_assignments
     where workspace_id = $1 and tag_id = $2 order by workflow_id limit $3`,
    [scope.workspaceId, tagId, TAG_DELETE_WORKFLOW_LIMIT + 1],
  );
  if (assigned.rows.length > TAG_DELETE_WORKFLOW_LIMIT)
    throw new WorkflowTagConflictError('delete_overflow');
  const workflowIds = assigned.rows.map((row) => row.workflow_id);
  await client.query(
    `select 1 from app.workflows
     where workspace_id = $1 and id = any($2::uuid[]) order by id for update`,
    [scope.workspaceId, workflowIds],
  );
  await client.query(
    `insert into app.workflow_organization_state (workspace_id, workflow_id, revision)
     select $1, workflow_id, 2 from unnest($2::uuid[]) workflow_id
     on conflict (workspace_id, workflow_id) do update
     set revision = app.workflow_organization_state.revision + 1`,
    [scope.workspaceId, workflowIds],
  );
  await client.query(
    'delete from app.workflow_tag_assignments where workspace_id = $1 and tag_id = $2',
    [scope.workspaceId, tagId],
  );
  await client.query(
    'delete from app.workflow_tags where workspace_id = $1 and id = $2',
    [scope.workspaceId, tagId],
  );
  return workflowIds.length;
}

export function createWorkflowTagDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowTagDatabase {
  const session = createOrganizationSession(config, options.runtime);

  function tagCommand(
    input: Command,
    operation: string,
    target: string | null,
    request: unknown,
    apply: (client: PoolClient, workspaceId: string) => Promise<TagRow>,
  ): Promise<WorkflowTagCommandResult> {
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
            result: { tag: tagRecord(row) },
            audit: {
              action: `workflow.${operation}`,
              targetId: row.id,
              metadata: { revision: Number(row.revision) },
            },
          };
        },
      });
      return Object.freeze({ ...tagResult.parse(result), replayed });
    });
  }

  /** Replacing tags or detaching one from a workflow. */
  function assignmentCommand<T extends object>(
    input: AssignmentCommand,
    operation: 'tags.replace' | 'tag.detach',
    change: Exclude<OrganizationChange, Readonly<{ kind: 'move' }>>,
    schema: z.ZodType<T>,
  ): Promise<T & Readonly<{ replayed: boolean }>> {
    const workflowId = uuid.parse(input.workflowId);
    const expectedOrganizationRevision = revision.parse(
      input.expectedOrganizationRevision,
    );
    const request =
      change.kind === 'replace_tags'
        ? { tagIds: change.tagIds, expectedOrganizationRevision }
        : { tagId: change.tagId, expectedOrganizationRevision };
    return session.transact(input, async (client, scope) => {
      const { result, replayed } = await runOrganizationCommand(client, scope, {
        operation,
        target: workflowId,
        idempotencyKey: input.idempotencyKey,
        request,
        roles: operation === 'tags.replace' ? EDITORS : ADMINISTRATORS,
        replay: () =>
          checkOrganizationReplay(client, scope, workflowId, change.kind),
        apply: async () => {
          const organizationRevision = await organizeWorkflow(client, scope, {
            workflowId,
            change,
            expectedOrganizationRevision,
          });
          return {
            result: {
              workflowId,
              organizationRevision,
              ...(change.kind === 'replace_tags'
                ? { tagIds: change.tagIds }
                : {}),
            },
            audit: {
              action: `workflow.${operation}`,
              targetId: workflowId,
              metadata: { organizationRevision },
            },
          };
        },
      });
      return Object.freeze({ ...schema.parse(result), replayed });
    });
  }

  const store: WorkflowTagDatabase = {
    async listTags(input) {
      const { limit, after } = page(input);
      return session.transact(input, async (client, scope) => {
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
      return session.transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          ADMINISTRATORS,
        );
        // Tag visibility and the assignment page share one statement snapshot.
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

    createTag: async (input) => {
      const request = { key: key.parse(input.key) };
      return tagCommand(
        input,
        'tag.create',
        null,
        request,
        async (client, workspaceId) => {
          await requireFreeKey(client, workspaceId, request.key, null);
          const count = await client.query<{ count: number }>(
            'select count(*)::int count from app.workflow_tags where workspace_id = $1',
            [workspaceId],
          );
          if ((count.rows[0]?.count ?? 0) >= TAG_LIMIT)
            throw new WorkflowTagConflictError('limit');
          const created = await client.query<TagRow>(
            `insert into app.workflow_tags (workspace_id, id, key)
             values ($1, uuidv7(), $2) returning id, key, revision`,
            [workspaceId, request.key],
          );
          const row = created.rows[0];
          if (row === undefined) throw new Error('Tag was not created');
          return row;
        },
      );
    },

    renameTag: async (input) => {
      const tagId = uuid.parse(input.tagId);
      const request = {
        key: key.parse(input.key),
        expectedTagRevision: revision.parse(input.expectedTagRevision),
      };
      return tagCommand(
        input,
        'tag.rename',
        tagId,
        request,
        async (client, workspaceId) => {
          const current = await readTag(client, workspaceId, tagId);
          requireRevision(current, request.expectedTagRevision);
          await requireFreeKey(client, workspaceId, request.key, tagId);
          const renamed = await client.query<TagRow>(
            `update app.workflow_tags set key = $3, revision = revision + 1
             where workspace_id = $1 and id = $2 returning id, key, revision`,
            [workspaceId, tagId, request.key],
          );
          return renamed.rows[0] ?? current;
        },
      );
    },

    deleteTag: async (input) => {
      const tagId = uuid.parse(input.tagId);
      const request = {
        expectedTagRevision: revision.parse(input.expectedTagRevision),
      };
      return session.transact(input, async (client, scope) => {
        const { result, replayed } = await runOrganizationCommand(
          client,
          scope,
          {
            operation: 'tag.delete',
            target: tagId,
            idempotencyKey: input.idempotencyKey,
            request,
            roles: ADMINISTRATORS,
            apply: async () => {
              const current = await readTag(client, scope.workspaceId, tagId);
              requireRevision(current, request.expectedTagRevision);
              const detachedWorkflowCount = await deleteTag(
                client,
                scope,
                tagId,
              );
              return {
                result: { tagId, deleted: true, detachedWorkflowCount },
                audit: {
                  action: 'workflow.tag.delete',
                  targetId: tagId,
                  metadata: { detachedWorkflowCount },
                },
              };
            },
          },
        );
        return Object.freeze({ ...deleteResult.parse(result), replayed });
      });
    },

    replaceTags: async (input) =>
      assignmentCommand(
        input,
        'tags.replace',
        { kind: 'replace_tags', tagIds: tagIds.parse(input.tagIds) },
        replaceResult,
      ),

    detachTag: async (input) =>
      assignmentCommand(
        input,
        'tag.detach',
        { kind: 'detach_tag', tagId: uuid.parse(input.tagId) },
        assignment,
      ),

    close: session.close,
  };
  return Object.freeze(store);
}
