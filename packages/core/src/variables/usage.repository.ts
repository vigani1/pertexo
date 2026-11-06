import { readFolderScope } from '../shared/folder-access-facts.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowScopeSql } from '../shared/folder-scope.repository.js';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '@pertexo/database/schema';
import type { Role } from '@pertexo/policy';
import { and, eq, exists, gt, gte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type {
  VariableUsageInput,
  VariableUsagePage,
} from './workspace-variables.js';
import { walkVariableUsage } from './usage-walk.js';

type FolderScope = Awaited<ReturnType<typeof readFolderScope>>;
type UsageCursor = VariableUsageInput['after'];

export async function readVariableUsage(
  client: PoolClient,
  input: VariableUsageInput,
  role: Role,
): Promise<VariableUsagePage> {
  const scope = await readFolderScope(client, input, role);
  return walkVariableUsage(input, (after) =>
    readUsageWorkflow(client, input.workspaceId, scope, after),
  );
}

/** The next visible workflow, with its graphs. */
async function readUsageWorkflow(
  client: PoolClient,
  workspaceId: string,
  scope: FolderScope,
  after: UsageCursor,
) {
  const db = drizzle(client);
  // Limit the indexed identity page before loading any graphs.
  const candidates = db.$with('usage_candidates').as(
    db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          workflowScopeSql(scope, sql`${workflows.id}`),
          afterWorkflow(after),
        ),
      )
      .orderBy(workflows.id)
      .limit(2),
  );
  const [workflow] = await db
    .with(candidates)
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
          .select({ id: candidates.id })
          .from(candidates)
          .where(gt(candidates.id, workflows.id)),
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
        eq(
          workflows.id,
          sql`(${db.select({ id: candidates.id }).from(candidates).orderBy(candidates.id).limit(1)})`,
        ),
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
