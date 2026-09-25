import { createHash } from 'node:crypto';

import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  FailureNotificationDestinationError,
  type FailureNotificationDestinationErrorCode,
} from './failure-notification-destination-errors.js';
import { sha256HexSchema as digestSchema } from '../validation/persisted-primitives.js';

/*
 * Transaction, idempotency, authorization and audit steps shared by the
 * destination commands and the workflow failure-notification policy.
 */

export type CommandMetadata = Readonly<{
  workspaceId: string;
  actorId: string;
  requestId?: string;
  traceId?: string;
}>;

export type IdempotentCommandMetadata = CommandMetadata &
  Readonly<{
    idempotencyKey: string;
    requestHash: string;
  }>;

type DestinationAuditTarget = Readonly<{
  id: string;
  type: 'failure_notification_destination' | 'workflow';
}>;

export type DestinationTransaction = <T>(
  input: CommandMetadata,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

export function destinationError(
  code: FailureNotificationDestinationErrorCode,
  message: string,
): FailureNotificationDestinationError {
  return new FailureNotificationDestinationError(code, message);
}

const replaySchema = z
  .object({
    schemaVersion: z.literal(1),
    result: z.unknown(),
  })
  .strict();

function keyDigest(value: string): string {
  return createHash('sha256')
    .update(z.string().min(1).max(256).parse(value))
    .digest('hex');
}

export async function claimCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
  resourceId: string,
): Promise<
  Readonly<{ kind: 'new' }> | Readonly<{ kind: 'replay'; result: unknown }>
> {
  const keyHash = keyDigest(input.idempotencyKey);
  const requestHash = digestSchema.parse(input.requestHash);
  await client.query(
    `insert into app.idempotency_records
       (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
     values ($1,$2,$3,$4,$5,$6,'in_progress',$7,'{}'::jsonb)
     on conflict (workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      operation,
      scope,
      keyHash,
      requestHash,
      resourceId,
    ],
  );
  const result = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
  }>(
    `select request_hash,status,result_ref from app.idempotency_records
      where workspace_id=$1 and operation=$2 and scope=$3 and key_hash=$4
      for update`,
    [input.workspaceId, operation, scope, keyHash],
  );
  const claim = result.rows[0];
  if (claim === undefined)
    throw new Error('Destination idempotency claim is unavailable');
  if (claim.request_hash !== requestHash)
    throw destinationError(
      'idempotency_conflict',
      'Idempotency key request mismatch',
    );
  if (claim.status !== 'completed') return Object.freeze({ kind: 'new' });
  return Object.freeze({
    kind: 'replay',
    result: replaySchema.parse(claim.result_ref).result,
  });
}

export async function completeCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `update app.idempotency_records
        set status='completed',result_ref=$1::jsonb,updated_at=transaction_timestamp()
      where workspace_id=$2 and operation=$3 and scope=$4 and key_hash=$5`,
    [
      JSON.stringify({ schemaVersion: 1, result }),
      input.workspaceId,
      operation,
      scope,
      keyDigest(input.idempotencyKey),
    ],
  );
}

export async function authorize(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  manage: boolean,
): Promise<void> {
  const roles = manage ? ['owner', 'admin'] : ['owner', 'admin', 'builder'];
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
       join app.workspaces workspace on workspace.id=membership.workspace_id
       join app.users actor on actor.id=membership.user_id
      where membership.workspace_id=$1 and membership.user_id=$2
        and membership.status='active' and membership.role=any($3::text[])
        and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId, roles],
  );
  if (result.rowCount !== 1)
    throw destinationError('not_found', 'Destination is not visible');
}

export async function audit(
  client: PoolClient,
  input: CommandMetadata,
  action: string,
  target: DestinationAuditTarget,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      action,
      target.type,
      target.id,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify(metadata),
    ],
  );
}
