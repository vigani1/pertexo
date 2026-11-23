import type { PoolClient } from 'pg';
import type { ZodError } from 'zod';
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

type LocatedReference = Readonly<{
  path: string;
  reference: NodeArtifactReference;
}>;
type MalformedReference = Readonly<{
  kind: 'malformed';
  path: string;
  error: ZodError;
}>;
type ArtifactReferenceRefusal =
  | MalformedReference
  | Readonly<{
      kind: 'unavailable';
      path: string;
      error: ArtifactMetadataNotFoundError;
    }>;

export function collectArtifactReferences(
  value: unknown,
): readonly NodeArtifactReference[] {
  const collected = locateReferences(value);
  if (collected.kind === 'malformed') throw collected.error;
  return collected.references.map(({ reference }) => reference);
}

/** JSON is already bounded by its owning persistence boundary. */
function locateReferences(
  value: unknown,
):
  | MalformedReference
  | Readonly<{ kind: 'collected'; references: readonly LocatedReference[] }> {
  const references: LocatedReference[] = [];
  const pending = [{ value, path: '$' }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const { value: current, path } = entry;
    if (Array.isArray(current)) {
      const children: readonly unknown[] = current;
      pending.push(
        ...children.map((value, index) => ({
          value,
          path: `${path}[${String(index)}]`,
        })),
      );
    } else if (isRecord(current)) {
      if (isArtifactDescriptor(current)) {
        const { kind: _kind, ...descriptor } = current;
        const parsed = nodeArtifactReferenceSchema.safeParse(descriptor);
        if (!parsed.success)
          return { kind: 'malformed', path, error: parsed.error };
        references.push({ reference: parsed.data, path });
      } else {
        pending.push(
          ...Object.entries(current).map(([key, value]) => ({
            value,
            path: /^[a-zA-Z_][a-zA-Z_0-9]*$/u.test(key)
              ? `${path}.${key}`
              : `${path}[${JSON.stringify(key)}]`,
          })),
        );
      }
    }
  }
  return { kind: 'collected', references };
}

export async function lockArtifactReferences(
  client: PoolClient,
  workspaceId: string,
  value: unknown,
  actorId: string,
): Promise<void> {
  const refusal = await checkArtifactReferences(
    client,
    workspaceId,
    value,
    actorId,
  );
  if (refusal !== undefined) throw refusal.error;
}

export async function checkArtifactReferences(
  client: PoolClient,
  workspaceId: string,
  value: unknown,
  actorId: string,
): Promise<ArtifactReferenceRefusal | undefined> {
  const collected = locateReferences(value);
  if (collected.kind === 'malformed') return collected;
  const { references } = collected;
  if (references.length === 0) return undefined;
  const result = await lockAvailableReferenceRows(
    client,
    workspaceId,
    sortedIds(references.map(({ reference }) => reference)),
  );
  const visible = await visibleArtifactIds(
    client,
    { workspaceId, actorId },
    result
      .filter((row) => row.purpose !== ARTIFACT_UPLOAD_PURPOSE)
      .map((row) => row.id),
  );
  const rows = new Map(
    result
      .filter(
        (row) => row.purpose === ARTIFACT_UPLOAD_PURPOSE || visible.has(row.id),
      )
      .map((row) => [row.id, row]),
  );
  const unavailable = references.find(
    ({ reference }) => !matchesRow(reference, rows),
  );
  return unavailable === undefined
    ? undefined
    : {
        kind: 'unavailable',
        path: unavailable.path,
        error: new ArtifactMetadataNotFoundError(),
      };
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
  for (const reference of references)
    if (!matchesRow(reference, byId, previewRunId))
      throw new ArtifactMetadataNotFoundError();
}

function matchesRow(
  reference: NodeArtifactReference,
  rows: ReadonlyMap<string, ArtifactReferenceRow>,
  previewRunId?: string,
): boolean {
  const row = rows.get(reference.artifactId.toLowerCase());
  return (
    row !== undefined &&
    (row.previewRunId === null || previewRunId !== undefined) &&
    artifactMetadataMatches(row, reference)
  );
}
