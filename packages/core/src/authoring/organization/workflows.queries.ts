import { ROLES } from '@pertexo/workflow-model';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  workflowFavorites,
  workflowOrganizationState,
  workflowTagAssignments,
  workflowTags,
  workflows,
} from '@pertexo/database/schema';
import type { FolderScope } from '../../tenant-access/resources/contract.js';
import { readBrowsableFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import { workflowActions } from '../../tenant-access/resources/workflows.queries.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { WorkflowRecord } from '../workflows/representation/contract.js';
import { workflowProjection } from '../workflows/representation/records.queries.js';

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
/** Applies resource and organization filters before one bounded keyset page. */
export function createWorkflowOrganizationReadDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowOrganizationReadDatabase {
  const lease = acquireDatabasePool(config, options.runtime);

  const store: WorkflowOrganizationReadDatabase = {
    getWorkflow: (input) => readOrganizedWorkflow(lease.pool, input),
    listWorkflows: (input) => listOrganizedWorkflows(lease.pool, input),
    close: lease.close,
  };
  return Object.freeze(store);
}

async function transact<T>(
  pool: Pool,
  input: Scope,
  operation: (client: PoolClient, scope: Scope) => Promise<T>,
): Promise<T> {
  const { signal, ...base } = input;
  const scope: Scope = signal === undefined ? base : { ...base, signal };
  try {
    return await withTenantScopedClient(
      pool,
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
  await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
    actorId: scope.actorId,
    browsing: true,
    roles: ROLES,
  });
  const access = await readBrowsableFolderScope(client, scope);
  const filters = {
    ...input,
    view: input.view ?? 'all',
    favoritesOnly: input.favoritesOnly ?? false,
  };
  const projections = await organizedRows(client, {
    scope,
    input,
    access,
    filters,
  });
  const items = projections.slice(0, input.limit).map((row) => {
    const workflow = {
      ...row.workflow,
      resourceAccess: workflowActions(access, row.folderId),
    };
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
            id: last.workflow.id,
          })
        : null,
  });
}
function organizedRows(
  client: PoolClient,
  {
    scope,
    input,
    access,
    filters,
  }: Readonly<{
    scope: Scope;
    input: Parameters<typeof select>[2];
    access: FolderScope;
    filters: Required<
      Pick<WorkflowOrganizationFilters, 'view' | 'favoritesOnly'>
    > &
      WorkflowOrganizationFilters;
  }>,
) {
  const db = drizzle(client);
  const position =
    input.order === 'created_asc' ? workflows.createdAt : workflows.updatedAt;
  const tags = db
    .select({
      items: sql<
        WorkflowOrganizationMetadata['tags']
      >`coalesce(jsonb_agg(jsonb_build_object('id',${workflowTags.id},'key',${workflowTags.key},'revision',${workflowTags.revision}) order by ${workflowTags.id}),'[]'::jsonb)`,
    })
    .from(workflowTagAssignments)
    .innerJoin(
      workflowTags,
      and(
        eq(workflowTags.workspaceId, workflowTagAssignments.workspaceId),
        eq(workflowTags.id, workflowTagAssignments.tagId),
      ),
    )
    .where(
      and(
        eq(workflowTagAssignments.workspaceId, workflows.workspaceId),
        eq(workflowTagAssignments.workflowId, workflows.id),
      ),
    );
  return db
    .select({
      workflow: workflowProjection,
      organizationRevision:
        sql<number>`coalesce(${workflowOrganizationState.revision},1)`.mapWith(
          workflowOrganizationState.revision,
        ),
      folderId: workflowOrganizationState.folderId,
      tags: sql<WorkflowOrganizationMetadata['tags']>`(${tags})`,
      isFavorite: sql<boolean>`${isNotNull(workflowFavorites.workflowId)}`,
      positionAt: sql<string>`to_char(${position} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(workflows)
    .leftJoin(
      workflowOrganizationState,
      and(
        eq(workflowOrganizationState.workspaceId, workflows.workspaceId),
        eq(workflowOrganizationState.workflowId, workflows.id),
      ),
    )
    .leftJoin(
      workflowFavorites,
      and(
        eq(workflowFavorites.workspaceId, workflows.workspaceId),
        eq(workflowFavorites.workflowId, workflows.id),
        eq(workflowFavorites.actorId, scope.actorId),
      ),
    )
    .where(
      and(...organizedPredicates({ scope, input, access, filters, position })),
    )
    .orderBy(
      ...(input.order === 'created_asc'
        ? [asc(position), asc(workflows.id)]
        : [desc(position), desc(workflows.id)]),
    )
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
}
function organizedPredicates({
  scope,
  input,
  access,
  filters,
  position,
}: Readonly<{
  scope: Scope;
  input: Parameters<typeof select>[2];
  access: FolderScope;
  filters: Required<
    Pick<WorkflowOrganizationFilters, 'view' | 'favoritesOnly'>
  > &
    WorkflowOrganizationFilters;
  position: typeof workflows.createdAt | typeof workflows.updatedAt;
}>): SQL[] {
  const predicates = [
    eq(workflows.workspaceId, scope.workspaceId),
    workflowScopeSql(access, sql`${workflows.id}`),
  ];
  if (input.workflowId !== undefined)
    predicates.push(eq(workflows.id, input.workflowId));
  // PostgreSQL cannot store NUL, so a literal query containing it never matches.
  if (filters.query?.includes('\0') ?? false) predicates.push(sql`false`);
  else if (filters.query !== undefined && filters.query !== '') {
    const pattern = `%${filters.query.replace(/[\\%_]/gu, (letter) => `\\${letter}`)}%`;
    predicates.push(
      sql`lower(${workflows.name} COLLATE "C") LIKE lower(${pattern} COLLATE "C") ESCAPE '\\'`,
    );
  }
  if (filters.view !== 'all')
    predicates.push(eq(workflows.lifecycleStatus, filters.view));
  if (filters.tagId !== undefined) {
    const selected = new QueryBuilder()
      .select({ id: workflowTagAssignments.tagId })
      .from(workflowTagAssignments)
      .where(
        and(
          eq(workflowTagAssignments.workspaceId, workflows.workspaceId),
          eq(workflowTagAssignments.workflowId, workflows.id),
          eq(workflowTagAssignments.tagId, filters.tagId),
        ),
      );
    predicates.push(exists(selected));
  }
  if (filters.favoritesOnly)
    predicates.push(isNotNull(workflowFavorites.workflowId));
  if (filters.folderId === 'root')
    predicates.push(isNull(workflowOrganizationState.folderId));
  else if (filters.folderId !== undefined)
    predicates.push(eq(workflowOrganizationState.folderId, filters.folderId));
  if (input.after !== undefined) {
    const after = input.after;
    predicates.push(
      input.order === 'created_asc'
        ? sql`(${position},${workflows.id})>(${after.positionAt}::timestamptz,${after.id}::uuid)`
        : sql`(${position},${workflows.id})<(${after.positionAt}::timestamptz,${after.id}::uuid)`,
    );
  }
  return predicates;
}

function readOrganizedWorkflow(
  pool: Pool,
  input: Parameters<WorkflowOrganizationReadDatabase['getWorkflow']>[0],
): ReturnType<WorkflowOrganizationReadDatabase['getWorkflow']> {
  return transact(
    pool,
    input,
    async (client, scope) =>
      (
        await select(client, scope, {
          workflowId: input.workflowId,
          limit: 1,
          order: 'created_asc',
        })
      ).items[0] ?? null,
  );
}

function listOrganizedWorkflows(
  pool: Pool,
  input: Parameters<WorkflowOrganizationReadDatabase['listWorkflows']>[0],
): ReturnType<WorkflowOrganizationReadDatabase['listWorkflows']> {
  const limit = input.limit ?? 50;
  const order = input.order ?? 'created_asc';
  return transact(pool, input, (client, scope) =>
    select(client, scope, { ...input, limit, order }),
  );
}
