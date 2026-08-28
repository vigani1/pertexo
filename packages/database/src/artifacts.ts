import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  artifactLinks,
  artifacts,
  runCheckpoints,
  runEvents,
} from './schema.js';
import type { WorkspaceTransaction } from './workspace.js';

export const ARTIFACT_STATUS = {
  available: 'available',
  deleted: 'deleted',
  deleting: 'deleting',
  pending: 'pending',
} as const;

export type ArtifactStatus =
  (typeof ARTIFACT_STATUS)[keyof typeof ARTIFACT_STATUS];
export type ArtifactRecord = typeof artifacts.$inferSelect;
export type ArtifactCapacityObservation = Readonly<{
  bytes: number;
  count: number;
  status: ArtifactStatus;
}>;
export type ExecutionStorageObservation = Readonly<{
  bytes: number;
  count: number;
  surface: 'checkpoint' | 'event';
}>;

const metadataSchema = z.object({
  artifactId: z.uuid(),
  byteLength: z
    .number()
    .int()
    .min(0)
    .max(5 * 1024 * 1024 * 1024),
  mediaType: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[^\s/;]+\/[^\r\n]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  storageKey: z.string().min(1).max(512),
});
const pendingArtifactSchema = metadataSchema.extend({
  expiresAt: z.date(),
  purpose: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]{0,63}$/u),
});
const pendingPreviewArtifactSchema = pendingArtifactSchema.extend({
  previewRunId: z.uuid(),
});
const finalizeArtifactSchema = metadataSchema.extend({ workspaceId: z.uuid() });
const claimInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
});
const claimOneInputSchema = z.object({ artifactId: z.uuid() });
const removalInputSchema = z.object({ artifactId: z.uuid() });

export type CreatePendingArtifactInput = z.input<typeof pendingArtifactSchema>;
export type CreatePendingPreviewArtifactInput = z.input<
  typeof pendingPreviewArtifactSchema
>;
export type FinalizeArtifactInput = z.input<typeof finalizeArtifactSchema>;
export type ClaimDueUnfinalizedArtifactsInput = z.input<
  typeof claimInputSchema
>;
export type ClaimDueUnfinalizedArtifactInput = z.input<
  typeof claimOneInputSchema
>;
export type CompleteArtifactRemovalInput = z.input<typeof removalInputSchema>;

export class ArtifactFinalizeConflictError extends Error {
  public constructor() {
    super('Validated object metadata does not match the pending artifact');
    this.name = 'ArtifactFinalizeConflictError';
  }
}

export class ArtifactLifecycleConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactLifecycleConflictError';
  }
}

export class ArtifactMetadataNotFoundError extends Error {
  public constructor() {
    super('Artifact metadata was not found in the workspace');
    this.name = 'ArtifactMetadataNotFoundError';
  }
}

function safeAggregateInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${field} exceeds the safe metric integer range`);
  }
  return parsed;
}

export async function readArtifactCapacity(
  transaction: WorkspaceTransaction,
): Promise<readonly ArtifactCapacityObservation[]> {
  const rows = await transaction.db
    .select({
      bytes: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)::text`,
      count: sql<string>`count(*)::text`,
      status: artifacts.status,
    })
    .from(artifacts)
    .groupBy(artifacts.status);
  const byStatus = new Map(
    rows.map((row) => [
      row.status,
      Object.freeze({
        bytes: safeAggregateInteger(row.bytes, 'artifact bytes'),
        count: safeAggregateInteger(row.count, 'artifact count'),
      }),
    ]),
  );

  return Object.freeze(
    Object.values(ARTIFACT_STATUS)
      .sort()
      .map((status) =>
        Object.freeze({
          bytes: byStatus.get(status)?.bytes ?? 0,
          count: byStatus.get(status)?.count ?? 0,
          status,
        }),
      ),
  );
}

export async function readExecutionStorageCapacity(
  transaction: WorkspaceTransaction,
): Promise<readonly ExecutionStorageObservation[]> {
  const [eventRows, checkpointRows] = await Promise.all([
    transaction.db
      .select({
        bytes: sql<string>`coalesce(sum(pg_column_size(${runEvents.payload})), 0)::text`,
        count: sql<string>`count(*)::text`,
      })
      .from(runEvents),
    transaction.db
      .select({
        bytes: sql<string>`coalesce(sum(pg_column_size(${runCheckpoints.schedulerState})), 0)::text`,
        count: sql<string>`count(*)::text`,
      })
      .from(runCheckpoints),
  ]);
  const event = eventRows[0];
  const checkpoint = checkpointRows[0];
  return Object.freeze([
    Object.freeze({
      bytes: safeAggregateInteger(event?.bytes ?? '0', 'run event bytes'),
      count: safeAggregateInteger(event?.count ?? '0', 'run event count'),
      surface: 'event' as const,
    }),
    Object.freeze({
      bytes: safeAggregateInteger(
        checkpoint?.bytes ?? '0',
        'run checkpoint bytes',
      ),
      count: safeAggregateInteger(
        checkpoint?.count ?? '0',
        'run checkpoint count',
      ),
      surface: 'checkpoint' as const,
    }),
  ]);
}

export function artifactStorageKey(
  workspaceId: string,
  artifactId: string,
): string {
  return `workspaces/${workspaceId}/artifacts/${artifactId}`;
}

function exactMetadataMatches(
  artifact: ArtifactRecord,
  validated: z.output<typeof finalizeArtifactSchema>,
): boolean {
  return (
    artifact.workspaceId === validated.workspaceId &&
    artifact.id === validated.artifactId &&
    artifact.byteLength === validated.byteLength &&
    artifact.mediaType === validated.mediaType &&
    artifact.sha256 === validated.sha256 &&
    artifact.storageKey === validated.storageKey
  );
}

export async function createPendingArtifact(
  transaction: WorkspaceTransaction,
  input: CreatePendingArtifactInput,
): Promise<ArtifactRecord> {
  const parsed = pendingArtifactSchema.parse(input);
  if (
    parsed.storageKey !==
    artifactStorageKey(transaction.workspaceId, parsed.artifactId)
  ) {
    throw new ArtifactFinalizeConflictError();
  }

  const rows = await transaction.db
    .insert(artifacts)
    .values({
      byteLength: parsed.byteLength,
      expiresAt: parsed.expiresAt,
      id: parsed.artifactId,
      mediaType: parsed.mediaType,
      purpose: parsed.purpose,
      sha256: parsed.sha256,
      status: ARTIFACT_STATUS.pending,
      storageKey: parsed.storageKey,
      workspaceId: transaction.workspaceId,
    })
    .returning();
  const artifact = rows[0];
  if (artifact === undefined) {
    throw new Error('Pending artifact insert returned no row');
  }
  return artifact;
}

/**
 * Creates preview artifact metadata and its immutable owner link in the same
 * tenant transaction. PostgreSQL independently enforces that the artifact
 * expiry cannot exceed the owning preview's retention deadline.
 */
export async function createPendingPreviewArtifact(
  transaction: WorkspaceTransaction,
  input: CreatePendingPreviewArtifactInput,
): Promise<ArtifactRecord> {
  const parsed = pendingPreviewArtifactSchema.parse(input);
  const artifact = await createPendingArtifact(transaction, parsed);
  await transaction.db.insert(artifactLinks).values({
    artifactId: artifact.id,
    ownerId: parsed.previewRunId,
    ownerKind: 'preview_run',
    workspaceId: transaction.workspaceId,
  });
  return artifact;
}

export async function finalizeArtifactUpload(
  transaction: WorkspaceTransaction,
  input: FinalizeArtifactInput,
): Promise<ArtifactRecord> {
  const parsed = finalizeArtifactSchema.parse(input);
  if (
    parsed.workspaceId !== transaction.workspaceId ||
    parsed.storageKey !==
      artifactStorageKey(parsed.workspaceId, parsed.artifactId)
  ) {
    throw new ArtifactFinalizeConflictError();
  }

  const locked = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, parsed.artifactId))
    .for('update');
  const artifact = locked[0];
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  if (!exactMetadataMatches(artifact, parsed)) {
    throw new ArtifactFinalizeConflictError();
  }
  if (artifact.status === ARTIFACT_STATUS.available) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.pending) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot be finalized from ${artifact.status}`,
    );
  }
  const expiry = await transaction.db.execute<{ expired: boolean }>(
    sql`select ${artifact.expiresAt}::timestamptz <= clock_timestamp() as expired`,
  );
  if (expiry.rows[0]?.expired !== false) {
    throw new ArtifactLifecycleConflictError('Pending artifact has expired');
  }

  const rows = await transaction.db
    .update(artifacts)
    .set({
      finalizedAt: sql`clock_timestamp()`,
      status: ARTIFACT_STATUS.available,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, parsed.artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.pending),
      ),
    )
    .returning();
  const finalized = rows[0];
  if (finalized === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact finalize lost its lock');
  }
  return finalized;
}

export async function claimDueUnfinalizedArtifacts(
  transaction: WorkspaceTransaction,
  input: ClaimDueUnfinalizedArtifactsInput,
): Promise<readonly ArtifactRecord[]> {
  const parsed = claimInputSchema.parse(input);
  const due = await transaction.db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.status, ARTIFACT_STATUS.pending),
        lte(artifacts.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(asc(artifacts.expiresAt), asc(artifacts.id))
    .limit(parsed.limit)
    .for('update', { skipLocked: true });
  if (due.length === 0) return Object.freeze([]);

  const claimed: ArtifactRecord[] = [];
  for (const candidate of due) {
    const rows = await transaction.db
      .update(artifacts)
      .set({
        status: ARTIFACT_STATUS.deleting,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(artifacts.id, candidate.id),
          eq(artifacts.status, ARTIFACT_STATUS.pending),
        ),
      )
      .returning();
    if (rows[0] !== undefined) claimed.push(rows[0]);
  }
  return Object.freeze(claimed);
}

export async function claimDueUnfinalizedArtifact(
  transaction: WorkspaceTransaction,
  input: ClaimDueUnfinalizedArtifactInput,
): Promise<ArtifactRecord> {
  const parsed = claimOneInputSchema.parse(input);
  const locked = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, parsed.artifactId))
    .for('update');
  const artifact = locked[0];
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  if (artifact.status === ARTIFACT_STATUS.deleting) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.pending) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot be claimed for unfinalized cleanup from ${artifact.status}`,
    );
  }
  const expiry = await transaction.db.execute<{ expired: boolean }>(
    sql`select ${artifact.expiresAt}::timestamptz <= clock_timestamp() as expired`,
  );
  if (expiry.rows[0]?.expired !== true) {
    throw new ArtifactLifecycleConflictError('Pending artifact is not due');
  }

  const rows = await transaction.db
    .update(artifacts)
    .set({
      status: ARTIFACT_STATUS.deleting,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, parsed.artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.pending),
      ),
    )
    .returning();
  const claimed = rows[0];
  if (claimed === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact cleanup lost its lock');
  }
  return claimed;
}

export async function completeArtifactRemoval(
  transaction: WorkspaceTransaction,
  input: CompleteArtifactRemovalInput,
): Promise<ArtifactRecord> {
  const parsed = removalInputSchema.parse(input);
  const locked = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, parsed.artifactId))
    .for('update');
  const artifact = locked[0];
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  if (artifact.status === ARTIFACT_STATUS.deleted) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.deleting) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot complete removal from ${artifact.status}`,
    );
  }

  const rows = await transaction.db
    .update(artifacts)
    .set({
      deletedAt: sql`clock_timestamp()`,
      status: ARTIFACT_STATUS.deleted,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, parsed.artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.deleting),
      ),
    )
    .returning();
  const deleted = rows[0];
  if (deleted === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact removal lost its lock');
  }
  return deleted;
}
