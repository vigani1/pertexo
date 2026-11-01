import { readFolderScope } from '../shared/facts.queries.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowScopeSql } from '../shared/scope.queries.js';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '@pertexo/database/schema';
import type { Role } from '@pertexo/workflow-model';
import { and, eq, exists, gt, gte, lt, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import type { VariableUsageInput, VariableUsagePage } from './contract.js';
import { walkVariableUsage } from './usage-walk.js';

type FolderScope = Awaited<ReturnType<typeof readFolderScope>>;
type UsageCursor = VariableUsageInput['after'];

export async function readVariableUsage(
  client: PoolClient,
  input: VariableUsageInput,
  role: Role,
): Promise<VariableUsagePage> {
  const scope = await readFolderScope(client, input, role);
  const page = await walkVariableUsage(input, (after) =>
    readUsageWorkflow(client, input.workspaceId, scope, after),
  );
  return {
    ...page,
    ...(await readUsageProgress(client, input.workspaceId, scope, page.next)),
  };
}

/** The next visible workflow, with its graphs. */
async function readUsageWorkflow(
  client: PoolClient,
  workspaceId: string,
  scope: FolderScope,
  after: UsageCursor,
) {
  const db = drizzle(client);
  const later = alias(workflows, 'later');
  const [workflow] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      lifecycleStatus: workflows.lifecycleStatus,
      draftRevision: workflowDrafts.revision,
      draftGraph: workflowDrafts.graphJson,
      versionId: workflowVersions.id,
      publishedGraph: workflowVersions.graphJson,
      hasMore: exists(
        db
          .select({ id: later.id })
          .from(later)
          .where(
            and(
              eq(later.workspaceId, workflows.workspaceId),
              gt(later.id, workflows.id),
              workflowScopeSql(scope, sql`${later.id}`),
            ),
          ),
      ).mapWith(Boolean),
    })
    .from(workflows)
    .leftJoin(
      workflowDrafts,
      and(
        eq(workflowDrafts.workspaceId, workflows.workspaceId),
        eq(workflowDrafts.workflowId, workflows.id),
      ),
    )
    .leftJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, workflows.workspaceId),
        eq(workflowVersions.workflowId, workflows.id),
        eq(workflowVersions.id, workflows.publishedVersionId),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        workflowScopeSql(scope, sql`${workflows.id}`),
        afterWorkflow(after),
      ),
    )
    .orderBy(workflows.id)
    .limit(1)
    .catch(rethrowQueryFailure);
  return workflow;
}

/** A partly scanned workflow is read again; a finished one is passed. */
function afterWorkflow(cursor: UsageCursor) {
  if (cursor === undefined) return undefined;
  return cursor.offset > 0
    ? gte(workflows.id, cursor.workflowId)
    : gt(workflows.id, cursor.workflowId);
}

/**
 * How far the check has got, counted from the cursor rather than added up by the
 * caller, so a page fetched twice can't count twice. Visible workflows only.
 */
async function readUsageProgress(
  client: PoolClient,
  workspaceId: string,
  scope: FolderScope,
  next: UsageCursor | null,
) {
  const [progress] = await drizzle(client)
    .select({
      totalWorkflows: sql<number>`count(*)::int`,
      checkedWorkflows: sql<number>`count(*) filter (where ${checkedWorkflow(next)})::int`,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        workflowScopeSql(scope, sql`${workflows.id}`),
      ),
    )
    .catch(rethrowQueryFailure);
  return progress ?? { totalWorkflows: 0, checkedWorkflows: 0 };
}

function checkedWorkflow(next: UsageCursor | null) {
  if (next === null || next === undefined) return sql`true`;
  return next.offset > 0
    ? lt(workflows.id, next.workflowId)
    : lte(workflows.id, next.workflowId);
}
