import { generatePersistedId } from '../../platform/persisted-id.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  FailureNotificationDestinationError,
  type FailureNotificationDestinationErrorCode,
} from './errors.js';
import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

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
    result: z.unknown(),
  })
  .strict();

function commandIdentity(
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
) {
  return {
    workspaceId: input.workspaceId,
    operation,
    scope,
    idempotencyKey: z.string().min(1).max(256).parse(input.idempotencyKey),
  };
}

/** Claims the command's key; a replay carries the stored result. */
export async function claimNotificationCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
  resourceId: string,
): Promise<
  Readonly<{ kind: 'new' }> | Readonly<{ kind: 'replay'; result: unknown }>
> {
  const stored = await claimCommand(client, {
    ...commandIdentity(input, operation, scope),
    requestHash: digestSchema.parse(input.requestHash),
    resourceId,
    conflict: () =>
      destinationError(
        'idempotency_conflict',
        'Idempotency key request mismatch',
      ),
  });
  if (stored === null) return Object.freeze({ kind: 'new' });
  return Object.freeze({
    kind: 'replay',
    result: replaySchema.parse(stored).result,
  });
}

export async function completeNotificationCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  operation: string,
  scope: string,
  result: unknown,
): Promise<void> {
  await completeCommand(client, commandIdentity(input, operation, scope), {
    result,
  });
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
