import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowDrafts,
  workflowPromotionOrigins,
  workflowVersionPromotions,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';
import { promotionDigest } from './preparation/graph.js';

/** Only the unchanged promoted draft can attribute a published version to its source. */
export async function recordPromotedPublication(
  client: PoolClient,
  version: WorkflowVersionRecord,
): Promise<void> {
  const db = drizzle(client);
  const scope = and(
    eq(workflowPromotionOrigins.workspaceId, version.workspaceId),
    eq(workflowPromotionOrigins.workflowId, version.workflowId),
  );
  const [row] = await db
    .select({ graphDigest: workflowPromotionOrigins.graphDigest })
    .from(workflowPromotionOrigins)
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowPromotionOrigins.workspaceId),
        eq(workflows.id, workflowPromotionOrigins.workflowId),
      ),
    )
    .innerJoin(
      workflowDrafts,
      and(
        eq(workflowDrafts.workspaceId, workflows.workspaceId),
        eq(workflowDrafts.workflowId, workflows.id),
      ),
    )
    .where(
      and(
        scope,
        eq(workflows.name, workflowPromotionOrigins.targetName),
        eq(workflowDrafts.revision, workflowPromotionOrigins.draftRevision),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row?.graphDigest !== promotionDigest(version.graphJson)) return;
  await db
    .insert(workflowVersionPromotions)
    .select(
      db
        .select({
          workspaceId: workflowPromotionOrigins.workspaceId,
          workflowId: workflowPromotionOrigins.workflowId,
          versionId: sql<string>`${version.id}::uuid`.as('version_id'),
          sourceWorkspaceId: workflowPromotionOrigins.sourceWorkspaceId,
          sourceWorkflowId: workflowPromotionOrigins.sourceWorkflowId,
          sourceVersionId: workflowPromotionOrigins.sourceVersionId,
          sourceChecksum: workflowPromotionOrigins.sourceChecksum,
          promotionId: workflowPromotionOrigins.promotionId,
          createdAt: sql<Date>`clock_timestamp()`.as('created_at'),
        })
        .from(workflowPromotionOrigins)
        .where(scope),
    )
    .onConflictDoNothing()
    .catch(rethrowQueryFailure);
  await db
    .update(workflowPromotionOrigins)
    .set({ publishedVersionId: version.id })
    .where(scope)
    .catch(rethrowQueryFailure);
}
