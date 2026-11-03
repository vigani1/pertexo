import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowInputCasePayloads,
  workflowInputCases,
  workflows,
} from '@pertexo/database/schema';

import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { Scope, WorkflowInputCaseMetadata } from './contract.js';
import {
  WorkflowInputCaseLimitError,
  WorkflowInputCaseRevisionConflictError,
} from './errors.js';

export const metadataProjection = {
  id: workflowInputCases.id,
  workspaceId: workflowInputCases.workspaceId,
  workflowId: workflowInputCases.workflowId,
  workflowVersionId: workflowInputCases.workflowVersionId,
  versionChecksum: workflowInputCases.versionChecksum,
  name: workflowInputCases.name,
  revision: workflowInputCases.revision,
  createdAt: workflowInputCases.createdAt,
  updatedAt: workflowInputCases.updatedAt,
};

export async function workflow(
  client: PoolClient,
  input: Scope,
  { write }: Readonly<{ write: boolean }>,
): Promise<void> {
  const row = await drizzle(client)
    .select({ lifecycleStatus: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const workflowUnavailable =
    row.length !== 1 || (write && row[0]?.lifecycleStatus !== 'active');
  if (workflowUnavailable)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

export async function quota(
  client: PoolClient,
  input: Scope,
  bytes: number,
  { create }: Readonly<{ create: boolean }>,
): Promise<void> {
  const db = drizzle(client);
  const retained = db
    .select({
      bytes: sql<number>`coalesce(sum(${workflowInputCasePayloads.canonicalBytes}),0)::float8`,
    })
    .from(workflowInputCasePayloads)
    .where(eq(workflowInputCasePayloads.workspaceId, input.workspaceId));
  const [row] = await db
    .select({
      workflowCount: sql<number>`count(*) filter(where ${workflowInputCases.workflowId}=${input.workflowId})::int`,
      workspaceCount: sql<number>`count(*)::int`,
      retainedBytes: sql<number>`(${retained})`,
    })
    .from(workflowInputCases)
    .where(
      and(
        eq(workflowInputCases.workspaceId, input.workspaceId),
        isNull(workflowInputCases.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  if (!row) throw new Error('Case quota authority unavailable');
  if (create && row.workflowCount >= 50)
    throw new WorkflowInputCaseLimitError('workflow_count');
  if (create && row.workspaceCount >= 200)
    throw new WorkflowInputCaseLimitError('workspace_count');
  if (row.retainedBytes + bytes > 4_194_304)
    throw new WorkflowInputCaseLimitError('retained_bytes');
}

export async function lockedCase(
  client: PoolClient,
  input: Scope & { caseId: string; expectedRevision: number },
): Promise<WorkflowInputCaseMetadata> {
  const [row] = await drizzle(client)
    .select(metadataProjection)
    .from(workflowInputCases)
    .where(
      and(
        eq(workflowInputCases.workspaceId, input.workspaceId),
        eq(workflowInputCases.workflowId, input.workflowId),
        eq(workflowInputCases.id, input.caseId),
        isNull(workflowInputCases.deletedAt),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (!row) throw new WorkflowNotFoundError('Run-input case is not visible');
  const item = Object.freeze(row);
  if (item.revision !== input.expectedRevision)
    throw new WorkflowInputCaseRevisionConflictError(item.revision);
  return item;
}

/** Cases and a suite's frozen manifest share one quota/mutation fence. */
export async function lockInputCaseQuota(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-input-case-quota:${workspaceId}`},0))`,
    )
    .catch(rethrowQueryFailure);
}
