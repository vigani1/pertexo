import { and, eq } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  workflowVersions,
  workflowVersionDependencies,
} from '@pertexo/database/schema';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

import type { CallableVersionSummary } from '@pertexo/workflow-model';
import { versionProjection } from '../workflows/representation/workflow-representations.repository.js';

export async function persistPublicationCalls(
  client: PoolClient,
  workspaceId: string,
  parentVersionId: string,
  calls: CallableVersionSummary['calls'],
): Promise<void> {
  for (const { nodeId, pin } of calls)
    await drizzle(client)
      .insert(workflowVersionDependencies)
      .values({
        workspaceId,
        parentVersionId,
        nodeId,
        targetWorkflowId: pin.workflowId,
        targetVersionId: pin.workflowVersionId,
      })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
}

export async function readPinnedVersion(
  client: PoolClient,
  workspaceId: string,
  pin: Readonly<{ workflowId: string; workflowVersionId: string }>,
) {
  const [row] = await drizzle(client)
    .select(versionProjection)
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
