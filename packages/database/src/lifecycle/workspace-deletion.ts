import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { requestActiveRunCancellations } from '../runs/runs.repository.js';
import { IdempotencyRequestConflictError } from '../runs/commands/acceptance.js';
import { databaseSchema } from '../schema.js';
import { WorkspaceLifecycleConflictError } from '../tenant-access/identity-workspace-errors.js';
import { parseWorkspaceId } from '../tenant-access/workspace.js';

/** How long a workspace waits for restore before it is purged. */
export const WORKSPACE_RECOVERY_DAYS = 30;

export type WorkspaceLifecycleCommandType =
  'deletion_requested' | 'deletion_restored';

/** The receipt of one deletion or restore request. */
export type WorkspaceLifecycleOperation = Readonly<{
  id: string;
  workspaceId: string;
  commandType: WorkspaceLifecycleCommandType;
  submittedAt: Date;
}>;

export type WorkspaceLifecycleChange = Readonly<{
  operationId: string;
  workspaceId: string;
  actorUserId: string;
  commandType: WorkspaceLifecycleCommandType;
  reason: string;
  idempotencyKeyHash: string;
  requestHash: string;
}>;

const operationRowSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  command_type: z.enum(['deletion_requested', 'deletion_restored']),
  actor_user_id: z.uuid(),
  reason: z.string(),
  request_hash: z.string(),
  occurred_at: z.coerce.date(),
});

function operation(
  row: z.output<typeof operationRowSchema>,
): WorkspaceLifecycleOperation {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    commandType: row.command_type,
    submittedAt: row.occurred_at,
  });
}

const OPERATION_COLUMNS =
  'id,workspace_id,command_type,actor_user_id,reason,request_hash,occurred_at';

/** Everything a workspace stops doing once deletion is requested. */
async function applyDeletionSideEffects(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
): Promise<void> {
  const workspace = [workspaceId];
  await client.query(
    `update app.sessions session set revoked_at = clock_timestamp()
     where session.revoked_at is null and exists (
       select 1 from app.workspace_memberships membership
       where membership.workspace_id = $1 and membership.user_id = session.user_id
         and membership.status <> 'removed')`,
    workspace,
  );
  await client.query(
    "select set_config('app.connection_health_protocol', '1', true)",
  );
  await client.query(
    `update app.connections
     set status = 'reauthorization_required', health_revision = health_revision + 1,
         last_health_transition_at = null, last_health_transition_source = null,
         last_error_code = 'workspace.pending_deletion', updated_at = clock_timestamp()
     where workspace_id = $1 and status = 'active'`,
    workspace,
  );
  await client.query(
    "select set_config('app.connection_health_protocol', '', true)",
  );
  await client.query(
    `update app.webhook_trigger_endpoints
     set status = 'disabled', previous_secret_version_id = null,
         previous_secret_valid_until = null, updated_at = clock_timestamp()
     where workspace_id = $1 and status <> 'disabled'`,
    workspace,
  );
  await client.query(
    `update app.trigger_schedules
     set status = 'disabled', health_status = 'disabled', last_error_code = null,
         lease_owner = null, lease_token = null, lease_acquired_at = null,
         lease_expires_at = null, updated_at = clock_timestamp()
     where workspace_id = $1`,
    workspace,
  );
  await client.query(
    `update app.workflow_triggers
     set status = 'disabled', health_status = 'disabled', last_error_code = null,
         reconciled_at = clock_timestamp(), updated_at = clock_timestamp()
     where workspace_id = $1`,
    workspace,
  );
  await client.query(
    `update app.workflows set activation_status = 'inactive', updated_at = clock_timestamp()
     where workspace_id = $1 and activation_status <> 'inactive'`,
    workspace,
  );
  await client.query(
    `update app.failure_notification_destinations
     set status = 'disabled', updated_at = clock_timestamp()
     where workspace_id = $1 and status = 'enabled'`,
    workspace,
  );
  // Invitation, then delivery attempt, then acceptance intent.
  await client.query(
    `update app.workspace_invitations
     set status = 'revoked', revision = revision + 1, revoked_at = clock_timestamp(),
         delivery_status = 'canceled', updated_at = clock_timestamp()
     where workspace_id = $1 and status = 'pending'`,
    workspace,
  );
  await client.query(
    `update app.workspace_invitation_delivery_attempts
     set status = case when status in ('queued', 'failed') then 'canceled' else status end,
         token_ciphertext = null, token_nonce = null, token_tag = null,
         token_key_version = null, updated_at = clock_timestamp()
     where workspace_id = $1 and status in ('queued', 'failed', 'unknown')`,
    workspace,
  );
  await client.query(
    `update app.workspace_invitation_acceptance_intents
     set status = 'superseded', updated_at = clock_timestamp()
     where workspace_id = $1 and status in ('pending', 'verified', 'wrong_account')`,
    workspace,
  );
  await requestActiveRunCancellations(
    Object.freeze({
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: parseWorkspaceId(workspaceId),
    }),
    { actorId: actorUserId, reason: 'Workspace deletion requested' },
  );
}

/**
 * Requests deletion of a workspace or restores it, in the caller's
 * workspace-scoped transaction. Deletion takes effect at once and the
 * workspace is purged after the recovery period; a repeated request with the
 * same idempotency key returns its first receipt.
 */
export async function changeWorkspaceLifecycle(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
): Promise<WorkspaceLifecycleOperation> {
  const workspace = await client.query<{
    status: string;
    restorable: boolean;
  }>(
    `select status, coalesce(clock_timestamp() < purge_after, false) restorable
     from app.workspaces where id = $1 for update`,
    [change.workspaceId],
  );
  const current = workspace.rows[0];
  if (current === undefined)
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
    );
  const owner = await client.query(
    `select 1 from app.users account
     join app.workspace_memberships membership on membership.user_id = account.id
     where account.id = $1 and account.status = 'active'
       and membership.workspace_id = $2 and membership.status = 'active'
       and membership.role = 'owner'`,
    [change.actorUserId, change.workspaceId],
  );
  if (owner.rowCount !== 1)
    throw new WorkspaceLifecycleConflictError(
      'actor_inactive',
      'Workspace lifecycle actor is not authorized',
    );

  const existing = await client.query(
    `select ${OPERATION_COLUMNS} from app.workspace_lifecycle_operations
     where workspace_id = $1 and idempotency_key_hash = $2`,
    [change.workspaceId, change.idempotencyKeyHash],
  );
  if (existing.rows[0] !== undefined) {
    const prior = operationRowSchema.parse(existing.rows[0]);
    if (
      prior.command_type !== change.commandType ||
      prior.actor_user_id !== change.actorUserId ||
      prior.reason !== change.reason ||
      prior.request_hash !== change.requestHash
    )
      throw new IdempotencyRequestConflictError();
    return operation(prior);
  }

  if (
    change.commandType === 'deletion_requested'
      ? current.status !== 'active' && current.status !== 'suspended'
      : current.status !== 'pending_deletion' || !current.restorable
  )
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
    );

  if (change.commandType === 'deletion_requested') {
    await client.query(
      `update app.workspaces
       set status = 'pending_deletion', deletion_requested_at = clock_timestamp(),
           deletion_requested_by = $2, deletion_reason = $3,
           purge_after = clock_timestamp() + make_interval(days => $4),
           updated_at = clock_timestamp()
       where id = $1`,
      [
        change.workspaceId,
        change.actorUserId,
        change.reason,
        WORKSPACE_RECOVERY_DAYS,
      ],
    );
    await applyDeletionSideEffects(
      client,
      change.workspaceId,
      change.actorUserId,
    );
  } else {
    await client.query(
      `update app.workspaces
       set status = 'active', deletion_requested_at = null,
           deletion_requested_by = null, deletion_reason = null,
           purge_after = null, updated_at = clock_timestamp()
       where id = $1`,
      [change.workspaceId],
    );
  }

  await client.query(
    `insert into app.audit_events
       (id, workspace_id, actor_user_id, action, target_type, target_id)
     values ($1, $2, $3, $4, 'workspace', $2)`,
    [
      change.operationId,
      change.workspaceId,
      change.actorUserId,
      change.commandType === 'deletion_requested'
        ? 'workspace.deletion_requested'
        : 'workspace.deletion_restored',
    ],
  );
  const inserted = await client.query(
    `insert into app.workspace_lifecycle_operations
       (id, workspace_id, idempotency_key_hash, command_type, actor_user_id,
        reason, request_hash, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
     returning ${OPERATION_COLUMNS}`,
    [
      change.operationId,
      change.workspaceId,
      change.idempotencyKeyHash,
      change.commandType,
      change.actorUserId,
      change.reason,
      change.requestHash,
    ],
  );
  return operation(operationRowSchema.parse(inserted.rows[0]));
}

/** One request's receipt, if it belongs to the workspace. */
export async function readWorkspaceLifecycleOperation(
  client: PoolClient,
  workspaceId: string,
  operationId: string,
): Promise<WorkspaceLifecycleOperation | null> {
  const result = await client.query(
    `select ${OPERATION_COLUMNS} from app.workspace_lifecycle_operations
     where workspace_id = $1 and id = $2`,
    [workspaceId, operationId],
  );
  const row: unknown = result.rows[0];
  return row === undefined ? null : operation(operationRowSchema.parse(row));
}
