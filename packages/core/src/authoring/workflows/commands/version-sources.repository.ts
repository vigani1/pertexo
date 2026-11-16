import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowOrganizationState,
  workflows,
  workflowVersions,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { WorkflowRef } from '../../../shared/access/workflow-actor.types.js';
import { versionProjection } from '../representation/workflow-representations.repository.js';

type VersionRef = WorkflowRef & Readonly<{ versionId: string }>;

/** A published version's stored graph, as a duplicate copies it. */
export async function readVersionGraph(
  client: PoolClient,
  { workspaceId, workflowId, versionId }: VersionRef,
): Promise<unknown> {
  const [row] = await drizzle(client)
    .select({ graphJson: workflowVersions.graphJson })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row?.graphJson;
}

/** One published version, as restoring it reads it. */
export async function readVersionRow(
  client: PoolClient,
  { workspaceId, workflowId, versionId }: VersionRef,
) {
  const [row] = await drizzle(client)
    .select(versionProjection)
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.id, versionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/**
 * What a recovery copy of a displaced draft is named and placed by: the
 * workflow's name, folder and published version, and today's UTC date.
 */
export async function readRecoveryCopySource(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
) {
  const [row] = await drizzle(client)
    .select({
      name: workflows.name,
      publishedVersionId: workflows.publishedVersionId,
      folderId: workflowOrganizationState.folderId,
      date: sql<string>`to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD')`,
    })
    .from(workflows)
    .leftJoin(
      workflowOrganizationState,
      and(
        eq(workflowOrganizationState.workspaceId, workflows.workspaceId),
        eq(workflowOrganizationState.workflowId, workflows.id),
      ),
    )
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  return row;
}
