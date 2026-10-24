import { RETAINED_RESOURCE_WORKSPACE_STATUSES } from './policy.js';
import { sql } from 'drizzle-orm';
import { workflowScopeSql } from './scope.queries.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { databaseSchema } from '../../schema.js';
import {
  parseWorkspaceId,
  withTenantScopedReadClient,
  withTenantScopedClient,
  type WorkspaceTransaction,
} from '../transactions.js';
import { lockWorkspaceAuthority } from '../workspaces/authority.queries.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import type {
  FolderScope,
  ResourceActor,
  WorkflowResourceCapability,
} from './contract.js';
import { readFolderScope } from './facts.queries.js';

export type ResourceTransaction = WorkspaceTransaction &
  Readonly<{ resources: FolderScope }>;

export function withRetainedResourceRead<T>(
  pool: Pool,
  input: ResourceActor & Readonly<{ signal?: AbortSignal | undefined }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
  statementTimeoutMillis?: number,
): Promise<T> {
  return withTenantScopedReadClient(
    pool,
    input,
    async (client) =>
      read({
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(input.workspaceId),
        resources: await readFolderScope(
          client,
          input,
          undefined,
          RETAINED_RESOURCE_WORKSPACE_STATUSES,
        ),
      }),
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(statementTimeoutMillis === undefined
        ? {}
        : { statementTimeoutMillis }),
    },
  );
}

export function withResourceCommand<T>(
  pool: Pool,
  input: ResourceActor & Readonly<{ signal?: AbortSignal | undefined }>,
  capability: WorkflowResourceCapability,
  command: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    input,
    async (client) => {
      const role = await lockWorkspaceAuthority(
        client,
        input.workspaceId,
        input.actorId,
        rolesForCapability(capability),
      );
      return command({
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(input.workspaceId),
        resources: await readFolderScope(client, input, role),
      });
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

/** One visible owner gates all subsequent value reads in this same snapshot. */
function withResourceOwnerRead<T>(
  pool: Pool,
  input: ResourceActor & Readonly<{ signal?: AbortSignal | undefined }>,
  owner: Readonly<{ kind: 'workflow' | 'run'; id: string }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withRetainedResourceRead(pool, input, async (transaction) => {
    const source =
      owner.kind === 'run'
        ? sql`app.workflow_runs resource_owner`
        : sql`app.workflows resource_owner`;
    const workflowId =
      owner.kind === 'run'
        ? sql`resource_owner.workflow_id`
        : sql`resource_owner.id`;
    const visible = await transaction.db.execute(sql`select 1 from ${source}
      where resource_owner.workspace_id=${transaction.workspaceId} and resource_owner.id=${owner.id}
      and ${workflowScopeSql(transaction.resources, workflowId)} limit 1`);
    if (visible.rows.length === 0) return undefined;
    return read(transaction);
  });
}

export function withResourceRunRead<T>(
  pool: Pool,
  input: ResourceActor &
    Readonly<{ runId: string; signal?: AbortSignal | undefined }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withResourceOwnerRead(
    pool,
    input,
    { kind: 'run', id: input.runId },
    read,
  );
}

export function withResourceWorkflowRead<T>(
  pool: Pool,
  input: ResourceActor &
    Readonly<{ workflowId: string; signal?: AbortSignal | undefined }>,
  read: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T | undefined> {
  return withResourceOwnerRead(
    pool,
    input,
    { kind: 'workflow', id: input.workflowId },
    read,
  );
}
