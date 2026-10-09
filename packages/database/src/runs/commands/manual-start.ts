import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { IdempotencyRequestConflictError } from './acceptance.js';
import { WorkflowRunNotFoundError } from '../errors.js';

export type ManualStartIdentity = Readonly<{
  actorId: string;
  workflowId: string;
  scope: string;
  idempotencyKeyHash: string;
  requestHash: string;
}>;
const rejectionSchema = z
  .object({
    request_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    expected_version_id: z.uuid(),
    observed_version_id: z.uuid(),
  })
  .strict();
export type ManualStartRejection = Readonly<{
  kind: 'published_version_conflict';
  expectedPublishedVersionId: string;
  observedPublishedVersionId: string;
}>;

/** Workspace/actor/membership authority precedes key serialization and all receipts. */
export async function lockManualStartCommand(
  transaction: WorkspaceTransaction,
  identity: ManualStartIdentity,
): Promise<void> {
  await transaction.db.execute(
    sql`select set_config('app.actor_id', ${identity.actorId}, true)`,
  );
  try {
    await transaction.db.execute(sql`select app.lock_manual_workflow_run_start(
      ${identity.actorId}::uuid, ${identity.workflowId}::uuid,
      ${identity.scope}::text, ${identity.idempotencyKeyHash}::text)`);
  } catch (error: unknown) {
    let current: unknown = error;
    for (let depth = 0; depth < 8; depth++) {
      const parsed = z
        .object({ code: z.string().optional(), cause: z.unknown().optional() })
        .loose()
        .safeParse(current);
      if (!parsed.success) break;
      if (parsed.data.code === 'PT404') throw new WorkflowRunNotFoundError();
      current = parsed.data.cause;
    }
    throw error;
  }
}

/** Caller has already resolved successful acceptance under the same command lock. */
export async function readManualStartRejection(
  transaction: WorkspaceTransaction,
  identity: ManualStartIdentity,
): Promise<ManualStartRejection | null> {
  const result = await transaction.db.execute(sql`select request_hash,
    expected_version_id, observed_version_id from app.workflow_manual_start_rejections
    where workspace_id=${transaction.workspaceId}::uuid
      and scope=${identity.scope} and key_hash=${identity.idempotencyKeyHash}`);
  if (result.rows[0] === undefined) return null;
  const row = rejectionSchema.parse(result.rows[0]);
  if (row.request_hash !== identity.requestHash)
    throw new IdempotencyRequestConflictError();
  return Object.freeze({
    kind: 'published_version_conflict',
    expectedPublishedVersionId: row.expected_version_id,
    observedPublishedVersionId: row.observed_version_id,
  });
}

export async function recordManualStartRejection(
  transaction: WorkspaceTransaction,
  identity: ManualStartIdentity,
  expectedPublishedVersionId: string,
  observedPublishedVersionId: string,
): Promise<ManualStartRejection> {
  await transaction.db
    .execute(sql`insert into app.workflow_manual_start_rejections
    (workspace_id,workflow_id,scope,key_hash,request_hash,expected_version_id,observed_version_id)
    values (${transaction.workspaceId}::uuid,${identity.workflowId}::uuid,
      ${identity.scope},${identity.idempotencyKeyHash},${identity.requestHash},
      ${expectedPublishedVersionId}::uuid,${observedPublishedVersionId}::uuid)`);
  return Object.freeze({
    kind: 'published_version_conflict',
    expectedPublishedVersionId,
    observedPublishedVersionId,
  });
}
