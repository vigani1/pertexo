import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workspaceCreationIdempotencyRecords as records } from '@pertexo/database/schema';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { generatePersistedId } from '@pertexo/database/platform';

import { IdempotencyRecordCorruptError } from '../../shared/command-receipt.errors.js';

import type {
  WorkspaceCreationResult as PublicWorkspaceCreationResult,
  WorkspaceRecord,
} from '../tenant-access.types.js';
import { WORKSPACE_STATUS } from '../state.js';

type WorkspaceCreationResult = PublicWorkspaceCreationResult;

// The idempotency snapshot for workspace creation, not a general
// workspace-row codec. A newly created workspace cannot be `purging`.
const durableWorkspaceResultSchema = z
  .object({
    workspace: z
      .object({
        id: z.uuid(),
        name: z.string(),
        slug: z.string(),
        status: z.enum([
          WORKSPACE_STATUS.active,
          WORKSPACE_STATUS.suspended,
          WORKSPACE_STATUS.pendingDeletion,
          WORKSPACE_STATUS.deleted,
        ]),
        createdBy: z.uuid(),
        deletionRequestedAt: z.iso.datetime().nullable(),
        deletionRequestedBy: z.uuid().nullable(),
        deletionReason: z.string().nullable(),
        purgeAfter: z.iso.datetime().nullable(),
        revision: z.number().int().positive().default(1),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

function durableWorkspaceResult(workspace: WorkspaceRecord) {
  return {
    workspace: {
      ...workspace,
      deletionRequestedAt: workspace.deletionRequestedAt?.toISOString() ?? null,
      purgeAfter: workspace.purgeAfter?.toISOString() ?? null,
      revision: workspace.revision,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    },
  };
}

export function parseDurableWorkspaceResult(
  value: unknown,
): WorkspaceCreationResult {
  const result = durableWorkspaceResultSchema.safeParse(value);
  if (!result.success) throw new IdempotencyRecordCorruptError();
  const workspace = result.data.workspace;
  return Object.freeze({
    workspace: Object.freeze({
      ...workspace,
      deletionRequestedAt:
        workspace.deletionRequestedAt === null
          ? null
          : new Date(workspace.deletionRequestedAt),
      purgeAfter:
        workspace.purgeAfter === null ? null : new Date(workspace.purgeAfter),
      createdAt: new Date(workspace.createdAt),
      updatedAt: new Date(workspace.updatedAt),
    }),
  });
}

type CreationKey = Readonly<{
  actorUserId: string;
  keyHash: string;
  requestHash: string;
}>;

const operation = 'workspace.create';

/** The new claim's ID, or undefined when this key already has a record. */
export async function insertCreationClaim(
  client: PoolClient,
  { actorUserId, keyHash, requestHash }: CreationKey,
): Promise<string | undefined> {
  const inserted = await drizzle(client)
    .insert(records)
    .values({
      id: generatePersistedId(),
      actorUserId,
      operation,
      keyHash,
      requestHash,
      status: 'in_progress',
    })
    .onConflictDoNothing({
      target: [records.actorUserId, records.operation, records.keyHash],
    })
    .returning({ id: records.id })
    .catch(rethrowQueryFailure);
  return inserted[0]?.id;
}

export async function readCreationRecord(
  client: PoolClient,
  { actorUserId, keyHash }: CreationKey,
) {
  const existing = await drizzle(client)
    .select({
      requestHash: records.requestHash,
      resultRef: records.resultRef,
      status: records.status,
    })
    .from(records)
    .where(
      and(
        eq(records.actorUserId, actorUserId),
        eq(records.operation, operation),
        eq(records.keyHash, keyHash),
      ),
    )
    .catch(rethrowQueryFailure);
  return existing[0];
}

export async function completeWorkspaceCreationCommand(
  client: PoolClient,
  claimId: string,
  result: WorkspaceCreationResult,
): Promise<void> {
  const completed = await drizzle(client)
    .update(records)
    .set({
      status: 'completed',
      resourceId: result.workspace.id,
      resultRef: durableWorkspaceResult(result.workspace),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(records.id, claimId), eq(records.status, 'in_progress')))
    .returning({ id: records.id })
    .catch(rethrowQueryFailure);
  if (completed.length !== 1) throw new IdempotencyRecordCorruptError();
}
