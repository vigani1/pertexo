import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import {
  and,
  eq,
  exists,
  getTableName,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  artifacts,
  artifactLinks,
  previewRuns,
} from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { artifactReferenceOwnersSql } from './owners.repository.js';

export type ArtifactReferenceRow = Awaited<
  ReturnType<typeof referenceRows>
>[number];

function referenceRows(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      id: artifacts.id,
      byteLength: artifacts.byteLength,
      mediaType: artifacts.mediaType,
      sha256: artifacts.sha256,
      purpose: artifacts.purpose,
      previewRunId: artifactLinks.ownerId,
    })
    .from(artifacts)
    .leftJoin(
      artifactLinks,
      and(
        eq(artifactLinks.workspaceId, artifacts.workspaceId),
        eq(artifactLinks.artifactId, artifacts.id),
      ),
    );
}

/** Share-locks the available artifacts among sorted `ids`. */
export async function lockAvailableReferenceRows(
  client: PoolClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<readonly ArtifactReferenceRow[]> {
  return referenceRows(drizzle(client))
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        inArray(artifacts.id, [...ids]),
        eq(artifacts.status, 'available'),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(artifacts.id)
    .for('share', { of: alias(artifacts, getTableName(artifacts)) })
    .catch(rethrowQueryFailure);
}

/**
 * Share-locks the available artifacts among sorted `ids` that an execution may
 * read: unowned ones, and preview outputs still live that `previewRunId` in the
 * same workflow consumes.
 */
export async function lockExecutionReferenceRows(
  transaction: WorkspaceTransaction,
  ids: readonly string[],
  previewRunId?: string,
): Promise<readonly ArtifactReferenceRow[]> {
  const db = transaction.db;
  const producer = alias(previewRuns, 'producer');
  const consumer = alias(previewRuns, 'consumer');
  return referenceRows(db)
    .leftJoin(
      producer,
      and(
        eq(producer.workspaceId, artifactLinks.workspaceId),
        eq(producer.id, artifactLinks.ownerId),
      ),
    )
    .where(
      and(
        eq(artifacts.workspaceId, transaction.workspaceId),
        inArray(artifacts.id, [...ids]),
        eq(artifacts.status, 'available'),
        isNull(artifacts.deletedAt),
        or(
          isNull(artifactLinks.ownerId),
          and(
            sql`${producer.expiresAt}>clock_timestamp()`,
            exists(
              db
                .select({ id: consumer.id })
                .from(consumer)
                .where(
                  and(
                    eq(consumer.workspaceId, transaction.workspaceId),
                    // A prior output carries over within a workflow, never out of it.
                    eq(consumer.workflowId, producer.workflowId),
                    previewRunId === undefined
                      ? sql`false`
                      : eq(consumer.id, previewRunId),
                    sql`${consumer.expiresAt}>clock_timestamp()`,
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .orderBy(artifacts.id)
    .for('share', { of: alias(artifacts, getTableName(artifacts)) });
}

/** Share-locks the available artifacts among sorted `ids` that the workflow owns. */
export async function lockWorkflowReferenceRows(
  db: Pick<NodePgDatabase, 'select'>,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
  ids: readonly string[],
): Promise<readonly ArtifactReferenceRow[]> {
  return referenceRows(db)
    .where(
      and(
        eq(artifacts.workspaceId, scope.workspaceId),
        inArray(artifacts.id, [...ids]),
        eq(artifacts.status, 'available'),
        isNull(artifacts.deletedAt),
        artifactReferenceOwnersSql(
          sql`${scope.workspaceId}`,
          sql`${artifacts.id}`,
          (workflow) => sql`${workflow}=${scope.workflowId}::uuid`,
        ),
      ),
    )
    .orderBy(artifacts.id)
    .for('share', { of: alias(artifacts, getTableName(artifacts)) })
    .catch(rethrowQueryFailure);
}
