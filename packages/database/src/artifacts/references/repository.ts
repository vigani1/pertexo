import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  visibleArtifactIds,
  visibleTransactionArtifactIds,
} from './access.queries.js';
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
import { artifacts } from '../../schema/transport.js';
import { artifactLinks } from '../../schema/runs/support.js';
import { previewRuns } from '../../schema/runs/execution.js';
import {
  nodeArtifactReferenceSchema,
  type NodeArtifactReference,
} from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { artifactMetadataMatches } from '../metadata/validation.js';
import { ArtifactMetadataNotFoundError } from '../input.js';

type ArtifactRow = Awaited<ReturnType<typeof referenceRows>>[number];
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
/** JSON is already bounded and validated by its owning persistence boundary. */
export function collectArtifactReferences(
  value: unknown,
): readonly NodeArtifactReference[] {
  const found: NodeArtifactReference[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      const children: readonly unknown[] = current;
      pending.push(...children);
    } else if (isRecord(current)) {
      const artifactReference =
        current.kind === 'artifact' &&
        'artifactId' in current &&
        'byteLength' in current &&
        'mediaType' in current &&
        'sha256' in current;
      if (artifactReference) {
        const { kind: _kind, ...descriptor } = current;
        found.push(nodeArtifactReferenceSchema.parse(descriptor));
      } else pending.push(...Object.values(current));
    }
  }
  return found;
}

function assertRows(
  references: readonly NodeArtifactReference[],
  rows: readonly ArtifactRow[],
  previewRunId?: string,
): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const reference of references) {
    const row = byId.get(reference.artifactId.toLowerCase());
    const invalidArtifactAuthority =
      row === undefined ||
      (row.previewRunId !== null && previewRunId === undefined) ||
      !artifactMetadataMatches(
        {
          byteLength: row.byteLength,
          mediaType: row.mediaType,
          sha256: row.sha256,
        },
        reference,
      );
    if (invalidArtifactAuthority) throw new ArtifactMetadataNotFoundError();
  }
}

export async function lockArtifactReferences(
  client: PoolClient,
  workspaceId: string,
  value: unknown,
  actorId: string,
): Promise<void> {
  const references = collectArtifactReferences(value);
  if (references.length === 0) return;
  const ids = [...new Set(references.map((ref) => ref.artifactId))].sort();
  const result = await referenceRows(drizzle(client))
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        inArray(artifacts.id, ids),
        eq(artifacts.status, 'available'),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(artifacts.id)
    .for('share', { of: alias(artifacts, getTableName(artifacts)) })
    .catch(rethrowQueryFailure);
  const visible = await visibleArtifactIds(
    client,
    { workspaceId, actorId },
    result.filter((row) => row.purpose !== 'user-upload').map((row) => row.id),
  );
  assertRows(
    references,
    result.filter(
      (row) => row.purpose === 'user-upload' || visible.has(row.id),
    ),
  );
}

export async function requireNodeArtifactReference(
  transaction: WorkspaceTransaction,
  reference: NodeArtifactReference,
  previewRunId?: string,
): Promise<void> {
  await lockExecutionReferences(transaction, [reference], previewRunId);
}

export async function lockExecutionArtifactReferences(
  transaction: WorkspaceTransaction,
  value: unknown,
  previewRunId?: string,
): Promise<void> {
  const references = collectArtifactReferences(value);
  if (references.length === 0) return;
  await lockExecutionReferences(transaction, references, previewRunId);
}

async function lockExecutionReferences(
  transaction: WorkspaceTransaction,
  references: readonly NodeArtifactReference[],
  previewRunId?: string,
): Promise<void> {
  const ids = [...new Set(references.map((ref) => ref.artifactId))].sort();
  const db = transaction.db;
  const producer = alias(previewRuns, 'producer');
  const consumer = alias(previewRuns, 'consumer');
  const result = await referenceRows(db)
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
        inArray(artifacts.id, ids),
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
  assertRows(references, result, previewRunId);
}

/** Authored inputs need source access; accepted immutable execution keeps its binding. */
export async function lockActorArtifactReferences(
  transaction: WorkspaceTransaction,
  actorId: string,
  value: unknown,
  previewRunId?: string,
): Promise<void> {
  const references = collectArtifactReferences(value);
  if (references.length === 0) return;
  const ids = [...new Set(references.map((reference) => reference.artifactId))];
  const visible = await visibleTransactionArtifactIds(
    transaction,
    { workspaceId: transaction.workspaceId, actorId },
    ids,
  );
  if (visible.size !== ids.length) throw new ArtifactMetadataNotFoundError();
  await lockExecutionArtifactReferences(transaction, value, previewRunId);
}
