import type { WorkflowCallPin } from '@pertexo/workflow-model';

import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflows,
  workflowVersions,
  workflowVersionPromotions,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { workflowScopeSql } from '../../../shared/folder-scope.repository.js';
import type { PoolClient } from 'pg';

export async function readPromotionCallMatch(
  client: PoolClient,
  sourceWorkspaceId: string,
  {
    targetWorkspaceId,
    resources,
    pin,
  }: Readonly<{
    targetWorkspaceId: string;
    resources: FolderScope;
    pin: WorkflowCallPin;
  }>,
) {
  const workflow = alias(workflows, 'workflow'),
    version = workflowVersions,
    origin = workflowVersionPromotions;
  const [match] = await drizzle(client)
    .select({
      workflow_id: version.workflowId,
      id: version.id,
      checksum: version.checksum,
    })
    .from(origin)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, origin.workspaceId),
        eq(version.workflowId, origin.workflowId),
        eq(version.id, origin.versionId),
      ),
    )
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, version.workspaceId),
        eq(workflow.id, version.workflowId),
      ),
    )
    .where(
      and(
        eq(origin.workspaceId, targetWorkspaceId),
        eq(origin.sourceWorkspaceId, sourceWorkspaceId),
        eq(origin.sourceWorkflowId, pin.workflowId),
        eq(origin.sourceVersionId, pin.workflowVersionId),
        eq(origin.sourceChecksum, pin.executableChecksum),
        workflowScopeSql(resources, sql`${workflow.id}`),
        eq(workflow.lifecycleStatus, 'active'),
      ),
    )
    .orderBy(desc(origin.createdAt), desc(version.id))
    .limit(1)
    .for('share', { of: workflow })
    .catch(rethrowQueryFailure);
  return match;
}
export async function readPromotionCallVersion(
  client: PoolClient,
  workspaceId: string,
  resources: FolderScope,
  pin: WorkflowCallPin,
) {
  const [row] = await drizzle(client)
    .select({
      graph_json: workflowVersions.graphJson,
      checksum: workflowVersions.checksum,
      workflow_id: workflowVersions.workflowId,
      visible: sql<boolean>`${workflowScopeSql(resources, sql`${workflowVersions.workflowId}`)}`,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.workflowId, pin.workflowId),
        eq(workflowVersions.id, pin.workflowVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}
