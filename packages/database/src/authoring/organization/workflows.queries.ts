import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { ROLES } from '../../tenant-access/policy.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { mapWorkflow, workflowRowSelection } from '../workflows/rows.js';
import type { WorkflowRecord } from '../workflows/records.js';

type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
type Position = Readonly<{ positionAt: string; id: string }>;
export type WorkflowOrganizationFilters = Readonly<{
  query?: string;
  view?: 'active' | 'archived' | 'all';
  tagId?: string;
  folderId?: string;
  favoritesOnly?: boolean;
}>;
export type WorkflowOrganizationMetadata = Readonly<{
  tags: readonly Readonly<{ id: string; key: string; revision: number }>[];
  organizationRevision: number;
  folderId: string | null;
  isFavorite: boolean;
}>;
export type WorkflowWithOrganization = Readonly<{
  workflow: WorkflowRecord;
  organization: WorkflowOrganizationMetadata;
}>;
export interface WorkflowOrganizationReadDatabase {
  getWorkflow(
    input: Scope & Readonly<{ workflowId: string }>,
  ): Promise<WorkflowWithOrganization | null>;
  listWorkflows(
    input: Scope &
      WorkflowOrganizationFilters &
      Readonly<{
        limit?: number;
        order?: 'created_asc' | 'updated_desc';
        after?: Position;
      }>,
  ): Promise<
    Readonly<{
      items: readonly WorkflowWithOrganization[];
      nextCursor: Position | null;
    }>
  >;
  close(): Promise<void>;
}
const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.object({
  workspaceId: uuid,
  actorId: uuid,
  signal: z.instanceof(AbortSignal).optional(),
});
const rowSchema = z
  .object({
    workflow: z.record(z.string(), z.unknown()),
    organizationRevision: revision,
    folderId: uuid.nullable(),
    tags: z
      .array(
        z
          .object({
            id: uuid,
            key: z
              .string()
              .min(1)
              .max(32)
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u),
            revision,
          })
          .strict(),
      )
      .max(16)
      .refine(
        (tags) =>
          new Set(tags.map((tag) => tag.id)).size === tags.length &&
          new Set(tags.map((tag) => tag.key)).size === tags.length,
      ),
    isFavorite: z.boolean(),
    positionAt: z.iso.datetime(),
  })
  .strict();
const filterSchema = z.object({
  query: z
    .string()
    .overwrite((value) => value.replace(/^ +| +$(?![\s\S])/gu, ''))
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 128)
    .optional(),
  view: z.enum(['active', 'archived', 'all']).default('all'),
  tagId: uuid.optional(),
  folderId: z.union([uuid, z.literal('root')]).optional(),
  favoritesOnly: z.boolean().default(false),
});

/** Uses the canonical authoring workflow row mapper; SQL predicates precede the
 * bounded keyset page and the organization batch never performs per-row reads. */
export function createWorkflowOrganizationReadDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowOrganizationReadDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  async function transact<T>(
    input: Scope,
    operation: (client: PoolClient, scope: Scope) => Promise<T>,
  ): Promise<T> {
    const { signal, ...base } = scopeSchema.parse(input);
    const scope: Scope = signal === undefined ? base : { ...base, signal };
    try {
      return await withTenantScopedClient(
        lease.pool,
        scope,
        (client) => operation(client, scope),
        signal === undefined ? {} : { signal },
      );
    } catch (error: unknown) {
      if (z.object({ code: z.literal('42501') }).safeParse(error).success)
        throw new WorkflowNotFoundError('Workflow is not visible');
      throw error;
    }
  }
  async function select(
    client: PoolClient,
    scope: Scope,
    input: Readonly<{
      limit: number;
      order: 'created_asc' | 'updated_desc';
      after?: Position;
      workflowId?: string;
    }> &
      WorkflowOrganizationFilters,
  ) {
    // Any active member reads organization, rechecked on every page.
    await lockWorkflowAuthoringAuthority(
      client,
      scope.workspaceId,
      scope.actorId,
      ROLES,
    );
    const values: unknown[] = [scope.workspaceId, scope.actorId];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${String(values.length)}`;
    };
    const predicates = ['w.workspace_id=$1'];
    const filters = filterSchema.parse({
      query: input.query,
      view: input.view,
      tagId: input.tagId,
      folderId: input.folderId,
      favoritesOnly: input.favoritesOnly,
    });
    if (input.workflowId !== undefined)
      predicates.push(`w.id=${parameter(uuid.parse(input.workflowId))}::uuid`);
    // PostgreSQL text cannot contain NUL: this valid literal query can never
    // match a stored name, and must not be sent as an invalid text parameter.
    if (filters.query?.includes('\0') === true) predicates.push('false');
    else if (filters.query !== undefined && filters.query !== '') {
      const pattern = `%${filters.query.replace(/[\\%_]/gu, (letter) => `\\${letter}`)}%`;
      predicates.push(
        String.raw`w.name COLLATE "C" LIKE ${parameter(pattern)} ESCAPE '\'`,
      );
    }
    if (filters.view !== 'all')
      predicates.push(`w.lifecycle_status=${parameter(filters.view)}`);
    if (filters.tagId !== undefined)
      predicates.push(
        `exists(select 1 from app.workflow_tag_assignments selected where selected.workspace_id=w.workspace_id and selected.workflow_id=w.id and selected.tag_id=${parameter(filters.tagId)}::uuid)`,
      );
    if (filters.favoritesOnly) predicates.push('f.workflow_id is not null');
    if (filters.folderId === 'root') predicates.push('s.folder_id is null');
    else if (filters.folderId !== undefined)
      predicates.push(`s.folder_id=${parameter(filters.folderId)}::uuid`);
    const orderColumn =
      input.order === 'created_asc' ? 'created_at' : 'updated_at';
    const ascending = input.order === 'created_asc';
    if (input.after !== undefined) {
      const position = z
        .object({ positionAt: z.iso.datetime({ offset: true }), id: uuid })
        .strict()
        .parse(input.after);
      predicates.push(
        `(w.${orderColumn},w.id) ${ascending ? '>' : '<'} (${parameter(position.positionAt)}::timestamptz,${parameter(position.id)}::uuid)`,
      );
    }
    const limit = parameter(input.limit + 1);
    const rows = await client.query<{ projection: unknown }>(
      `select jsonb_build_object(
      'workflow',row_to_json(w),'organizationRevision',coalesce(s.revision,1),'folderId',s.folder_id,
      'tags',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'key',t.key,'revision',t.revision) order by t.id)
        from app.workflow_tag_assignments a join app.workflow_tags t on t.workspace_id=a.workspace_id and t.id=a.tag_id
        where a.workspace_id=w.workspace_id and a.workflow_id=w.id),'[]'::jsonb),
      'isFavorite',f.workflow_id is not null,
      'positionAt',to_char(w.${orderColumn} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) projection
      from (select ${workflowRowSelection} from app.workflows) w left join app.workflow_organization_state s on s.workspace_id=w.workspace_id and s.workflow_id=w.id
      left join app.workflow_favorites f on f.workspace_id=w.workspace_id and f.workflow_id=w.id and f.actor_id=$2
      where ${predicates.join(' and ')} order by w.${orderColumn} ${ascending ? 'asc' : 'desc'},w.id ${ascending ? 'asc' : 'desc'} limit ${limit}`,
      values,
    );
    const projections = rows.rows.map(({ projection }) =>
      rowSchema.parse(projection),
    );
    const items = projections.slice(0, input.limit).map((row) => {
      const workflow = mapWorkflow(row.workflow);
      const organization: WorkflowOrganizationMetadata = Object.freeze({
        tags: Object.freeze(row.tags.map((tag) => Object.freeze(tag))),
        organizationRevision: row.organizationRevision,
        folderId: row.folderId,
        isFavorite: row.isFavorite,
      });
      return Object.freeze({ workflow, organization });
    });
    const last = projections.slice(0, input.limit).at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor:
        projections.length > input.limit && last !== undefined
          ? Object.freeze({
              positionAt: last.positionAt,
              id: uuid.parse(last.workflow.id),
            })
          : null,
    });
  }
  const store: WorkflowOrganizationReadDatabase = {
    getWorkflow: (input) =>
      transact(
        input,
        async (client, scope) =>
          (
            await select(client, scope, {
              workflowId: uuid.parse(input.workflowId),
              limit: 1,
              order: 'created_asc',
            })
          ).items[0] ?? null,
      ),
    listWorkflows: (input) => {
      const limit = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(input.limit ?? 50);
      const order = z
        .enum(['created_asc', 'updated_desc'])
        .parse(input.order ?? 'created_asc');
      return transact(input, (client, scope) =>
        select(client, scope, { ...input, limit, order }),
      );
    },
    close: lease.close,
  };
  return Object.freeze(store);
}
