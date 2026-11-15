import type { PoolClient } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  nodeArtifactReferenceSchema,
  type NodeArtifactReference,
} from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { isArtifactDescriptor } from './descriptor-shape.js';
import {
  visibleArtifactIds,
  visibleTransactionArtifactIds,
} from './access.repository.js';
import {
  lockAvailableReferenceRows,
  lockExecutionReferenceRows,
  lockWorkflowReferenceRows,
  type ArtifactReferenceRow,
} from './locks.repository.js';
import { artifactMetadataMatches } from '../metadata.js';
import { ARTIFACT_UPLOAD_PURPOSE } from '../artifact.js';
import { ArtifactMetadataNotFoundError } from '../artifact.errors.js';

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
      if (isArtifactDescriptor(current)) {
        const { kind: _kind, ...descriptor } = current;
        found.push(nodeArtifactReferenceSchema.parse(descriptor));
      } else pending.push(...Object.values(current));
    }
  }
  return found;
}

export async function lockArtifactReferences(
  client: PoolClient,
  workspaceId: string,
  value: unknown,
  actorId: string,
): Promise<void> {
  const references = collectArtifactReferences(value);
  if (references.length === 0) return;
  const result = await lockAvailableReferenceRows(
    client,
    workspaceId,
    sortedIds(references),
  );
  const visible = await visibleArtifactIds(
    client,
    { workspaceId, actorId },
    result
      .filter((row) => row.purpose !== ARTIFACT_UPLOAD_PURPOSE)
      .map((row) => row.id),
  );
  assertRows(
    references,
    result.filter(
      (row) => row.purpose === ARTIFACT_UPLOAD_PURPOSE || visible.has(row.id),
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

/** Authored inputs need source access; accepted immutable execution keeps its binding. */
export async function lockActorArtifactReferences(
  transaction: WorkspaceTransaction,
  actorId: string,
  value: unknown,
  previewRunId?: string,
): Promise<void> {
  const references = collectArtifactReferences(value);
  if (references.length === 0) return;
  const ids = [
    ...new Set(
      references.map((reference) => reference.artifactId.toLowerCase()),
    ),
  ];
  const visible = await visibleTransactionArtifactIds(
    transaction,
    { workspaceId: transaction.workspaceId, actorId },
    ids,
  );
  if (visible.size !== ids.length) throw new ArtifactMetadataNotFoundError();
  await lockExecutionArtifactReferences(transaction, value, previewRunId);
}

/** An ingress token authorizes its workflow, not files owned by other workflows. */
export async function lockWorkflowArtifactReferences(
  db: Pick<NodePgDatabase, 'select'>,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
  value: unknown,
): Promise<void> {
  const references = collectArtifactReferences(value);
  if (references.length === 0) return;
  const rows = await lockWorkflowReferenceRows(
    db,
    scope,
    sortedIds(references),
  );
  assertRows(references, rows);
}

async function lockExecutionReferences(
  transaction: WorkspaceTransaction,
  references: readonly NodeArtifactReference[],
  previewRunId?: string,
): Promise<void> {
  const result = await lockExecutionReferenceRows(
    transaction,
    sortedIds(references),
    previewRunId,
  );
  assertRows(references, result, previewRunId);
}

function sortedIds(references: readonly NodeArtifactReference[]): string[] {
  return [
    ...new Set(references.map((ref) => ref.artifactId.toLowerCase())),
  ].sort();
}

function assertRows(
  references: readonly NodeArtifactReference[],
  rows: readonly ArtifactReferenceRow[],
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
