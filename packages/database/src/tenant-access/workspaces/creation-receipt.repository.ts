import { canonicalJson } from '@pertexo/workflow-model';
import { createHash, randomUUID } from 'node:crypto';

import { generatePersistedId } from '../../platform/persisted-id.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  IDEMPOTENCY_STATUS,
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
} from '../../runs/commands/acceptance.js';

import {
  WORKSPACE_STATUS,
  type WorkspaceCreationResult as PublicWorkspaceCreationResult,
  type WorkspaceRecord,
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
  const inserted = await client.query<{ id: string }>(
    `insert into app.workspace_creation_idempotency_records
       (id, actor_user_id, operation, key_hash, request_hash, status)
     values ($1, $2, $3, $4, $5, 'in_progress')
     on conflict (actor_user_id, operation, key_hash) do nothing
     returning id`,
    [generatePersistedId(), actorUserId, operation, keyHash, requestHash],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId !== undefined) return { claimed: true, id: insertedId };

  const existing = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash, status, result_ref
     from app.workspace_creation_idempotency_records
     where actor_user_id = $1 and operation = $2 and key_hash = $3`,
    [actorUserId, operation, keyHash],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new IdempotencyRecordCorruptError();
  if (row.request_hash !== requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  if (row.status !== IDEMPOTENCY_STATUS.completed) {
    throw new IdempotencyRecordCorruptError();
  }
  return {
    claimed: false,
    result: parseDurableWorkspaceResult(row.result_ref),
  };
}

export async function completeWorkspaceCreationCommand(
  client: PoolClient,
  claimId: string,
  result: WorkspaceCreationResult,
): Promise<void> {
  const completed = await client.query(
    `update app.workspace_creation_idempotency_records
     set status = 'completed', resource_id = $2, result_ref = $3::jsonb,
         updated_at = clock_timestamp()
     where id = $1 and status = 'in_progress'`,
    [
      claimId,
      result.workspace.id,
      JSON.stringify(durableWorkspaceResult(result.workspace)),
    ],
  );
  if (completed.rowCount !== 1) throw new IdempotencyRecordCorruptError();
}
