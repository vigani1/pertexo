import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceCreationIdempotencyRecords as records } from '../../schema/runs/support.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { createHash, randomUUID } from 'node:crypto';

import { generatePersistedId } from '../../platform/persisted-id.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  IDEMPOTENCY_STATUS,
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
} from '../../runs/commands/acceptance.repository.js';

import { WORKSPACE_STATUS } from '../state.js';
import type {
  WorkspaceCreationResult as PublicWorkspaceCreationResult,
  WorkspaceRecord,
} from '../contract.js';

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

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

function durableWorkspaceResult(
  workspace: WorkspaceRecord,
): z.output<typeof durableWorkspaceResultSchema> {
  return durableWorkspaceResultSchema.parse({
    workspace: {
      ...workspace,
      deletionRequestedAt: workspace.deletionRequestedAt?.toISOString() ?? null,
      purgeAfter: workspace.purgeAfter?.toISOString() ?? null,
      revision: workspace.revision,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    },
  });
}

function parseDurableWorkspaceResult(value: unknown): WorkspaceCreationResult {
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function commandRequestHash(value: Record<string, unknown>): string {
  return sha256(canonicalJson(value));
}

export function commandKeyHash(value: string | undefined): string {
  return sha256(idempotencyKeySchema.parse(value ?? randomUUID()));
}

type CommandClaim =
  | Readonly<{ claimed: true; id: string }>
  | Readonly<{ claimed: false; result: WorkspaceCreationResult }>;

export async function claimWorkspaceCreationCommand(
  client: PoolClient,
  actorUserId: string,
  keyHash: string,
  requestHash: string,
): Promise<CommandClaim> {
  const operation = 'workspace.create';
  const db = drizzle(client);
  const inserted = await db
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
  const insertedId = inserted[0]?.id;
  if (insertedId !== undefined) return { claimed: true, id: insertedId };

  const existing = await db
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
  const row = existing[0];
  if (row === undefined) throw new IdempotencyRecordCorruptError();
  if (row.requestHash !== requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  if (row.status !== IDEMPOTENCY_STATUS.completed) {
    throw new IdempotencyRecordCorruptError();
  }
  return {
    claimed: false,
    result: parseDurableWorkspaceResult(row.resultRef),
  };
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
