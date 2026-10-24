import {
  visibleArtifactIds,
  visibleTransactionArtifactIds,
} from './access.queries.js';
import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import {
  nodeArtifactReferenceSchema,
  type NodeArtifactReference,
} from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { artifactMetadataMatches } from '../metadata/contract.js';
import { ArtifactMetadataNotFoundError } from '../repository.js';

type ArtifactRow = Record<string, unknown> & {
  id: string;
  byte_length: number | string;
  media_type: string;
  sha256: string;
  preview_run_id: string | null;
  purpose: string;
};

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
      (row.preview_run_id !== null && previewRunId === undefined) ||
      !artifactMetadataMatches(
        {
          byteLength: Number(row.byte_length),
          mediaType: row.media_type,
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
  const result = await client.query<ArtifactRow>(
    `select artifact.id, artifact.byte_length, artifact.media_type, artifact.sha256, artifact.purpose,
      link.owner_id as preview_run_id
     from app.artifacts artifact
     left join app.artifact_links link
       on link.workspace_id=artifact.workspace_id and link.artifact_id=artifact.id
     where artifact.workspace_id=$1 and artifact.id=any($2::uuid[])
       and artifact.status='available' and artifact.deleted_at is null
     order by artifact.id for share of artifact`,
    [workspaceId, ids],
  );
  const visible = await visibleArtifactIds(
    client,
    { workspaceId, actorId },
    result.rows
      .filter((row) => row.purpose !== 'user-upload')
      .map((row) => row.id),
  );
  assertRows(
    references,
    result.rows.filter(
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
  const result = await transaction.db.execute<ArtifactRow>(sql`
    select artifact.id, artifact.byte_length, artifact.media_type, artifact.sha256, artifact.purpose,
      link.owner_id as preview_run_id
    from app.artifacts artifact
    left join app.artifact_links link
      on link.workspace_id=artifact.workspace_id and link.artifact_id=artifact.id
    left join app.preview_runs producer
      on producer.workspace_id=link.workspace_id and producer.id=link.owner_id
    where artifact.workspace_id=${transaction.workspaceId}
      and artifact.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      and artifact.status='available' and artifact.deleted_at is null
      and (link.owner_id is null or (
        producer.expires_at > clock_timestamp() and exists (
          select 1 from app.preview_runs consumer
          where consumer.workspace_id=${transaction.workspaceId}
            and consumer.id=${previewRunId ?? null}::uuid
            and consumer.expires_at > clock_timestamp()
        )
      ))
    order by artifact.id for share of artifact
  `);
  assertRows(references, result.rows, previewRunId);
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
