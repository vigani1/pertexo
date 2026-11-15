import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowInputCasePayloads,
  workflowInputCases,
  workflows,
} from '@pertexo/database/schema';

import type {
  Scope,
  WorkflowInputCaseMetadata,
} from './workflow-input-case.types.js';

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

/** The workflow's lifecycle, shared while its cases change or are read. */
export async function shareCaseWorkflow(client: PoolClient, input: Scope) {
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
  return row.length === 1 ? row[0] : undefined;
}

/** The workflow's and workspace's live cases and the workspace's retained case bytes. */
export async function readCaseQuota(client: PoolClient, input: Scope) {
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
  return row;
}

/** The live case, locked for its change. */
export async function lockCase(
  client: PoolClient,
  input: Scope & { caseId: string },
): Promise<WorkflowInputCaseMetadata | undefined> {
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
  return row === undefined ? undefined : Object.freeze(row);
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
