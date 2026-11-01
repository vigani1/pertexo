import { appendAuditFact } from '../../governance/audit/events.repository.js';
import type {
  WorkspaceLifecycleCommandType,
  WorkspaceLifecycleOperation,
  WorkspaceLifecycleChange,
} from './contract.js';
import { connections } from '../../schema/connections.js';
import { deleteWorkspaceOAuth2Grants } from '../../connections/oauth2/clients.repository.js';
import { apiTokens } from '../../schema/identity/api-tokens.js';
import { webhookTriggerEndpoints } from '../../schema/triggers/endpoints.js';
import { triggerSchedules } from '../../schema/triggers/schedules.js';
import {
  workflowTriggers,
  workflows,
} from '../../schema/authoring/workflows.js';
import { failureNotificationDestinations } from '../../schema/notifications.js';
import {
  workspaceInvitations,
  workspaceInvitationDeliveryAttempts,
  workspaceInvitationAcceptanceIntents,
  workspaces,
  users,
  workspaceMemberships,
  workspaceLifecycleOperations,
} from '../../schema/foundation.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { rethrowQueryFailure } from '../../platform/query-errors.js';

import { requestActiveRunCancellations } from '../../runs/commands/cancel-active.repository.js';
import { IdempotencyRequestConflictError } from '../../runs/commands/acceptance/errors.js';
import { databaseSchema } from '../../schema.js';
import { WorkspaceLifecycleConflictError } from '../../tenant-access/errors.js';
import type { WorkspaceId } from '../../tenant-access/transactions.js';

/** How long a workspace waits for restore before it is purged. */
export const WORKSPACE_RECOVERY_DAYS = 30;

/** Invitation, then delivery attempt, then acceptance intent. */
async function cancelPendingInvitations(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(workspaceInvitations)
    .set({
      status: 'revoked',
      revision: sql`${workspaceInvitations.revision}+1`,
      revokedAt: sql`clock_timestamp()`,
      deliveryStatus: 'canceled',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(workspaceInvitationDeliveryAttempts)
    .set({
      status: sql`case when ${workspaceInvitationDeliveryAttempts.status} in ('queued','failed') then 'canceled' else ${workspaceInvitationDeliveryAttempts.status} end`,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      tokenKeyVersion: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workspaceInvitationDeliveryAttempts.workspaceId, workspaceId),
        inArray(workspaceInvitationDeliveryAttempts.status, [
          'queued',
          'failed',
          'unknown',
        ]),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(workspaceInvitationAcceptanceIntents)
    .set({ status: 'superseded', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(workspaceInvitationAcceptanceIntents.workspaceId, workspaceId),
        inArray(workspaceInvitationAcceptanceIntents.status, [
          'pending',
          'verified',
          'wrong_account',
        ]),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Everything a workspace stops doing once deletion is requested. */
async function applyDeletionSideEffects(
  client: PoolClient,
  workspaceId: string,
  actorUserId: string,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(apiTokens)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(
      and(eq(apiTokens.workspaceId, workspaceId), isNull(apiTokens.revokedAt)),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(connections)
    .set({
      status: 'reauthorization_required',
      healthRevision: sql`${connections.healthRevision}+1`,
      lastHealthTransitionAt: null,
      lastHealthTransitionSource: null,
      lastErrorCode: 'workspace.pending_deletion',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  await deleteWorkspaceOAuth2Grants(client, workspaceId);
  await db
    .update(webhookTriggerEndpoints)
    .set({
      status: 'disabled',
      previousSecretVersionId: null,
      previousSecretValidUntil: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(webhookTriggerEndpoints.workspaceId, workspaceId),
        ne(webhookTriggerEndpoints.status, 'disabled'),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(triggerSchedules)
    .set({
      status: 'disabled',
      healthStatus: 'disabled',
      lastErrorCode: null,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(triggerSchedules.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  await db
    .update(workflowTriggers)
    .set({
      status: 'disabled',
      healthStatus: 'disabled',
      lastErrorCode: null,
      reconciledAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowTriggers.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  await db
    .update(workflows)
    .set({ activationStatus: 'inactive', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        ne(workflows.activationStatus, 'inactive'),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(failureNotificationDestinations)
    .set({ status: 'disabled', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(failureNotificationDestinations.workspaceId, workspaceId),
        eq(failureNotificationDestinations.status, 'enabled'),
      ),
    )
    .catch(rethrowQueryFailure);
  await cancelPendingInvitations(client, workspaceId);
  await requestActiveRunCancellations(
    Object.freeze({
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: workspaceId as WorkspaceId,
    }),
    { actorId: actorUserId, reason: 'Workspace deletion requested' },
  );
}

type WorkspaceLifecycleState = Readonly<{
  status: string;
  restorable: boolean;
}>;

const COMMANDS: Readonly<
  Record<
    WorkspaceLifecycleCommandType,
    Readonly<{
      auditAction: string;
      appliesTo: (current: WorkspaceLifecycleState) => boolean;
    }>
  >
> = {
  deletion_requested: {
    auditAction: 'workspace.deletion_requested',
    appliesTo: ({ status }) => status === 'active' || status === 'suspended',
  },
  deletion_restored: {
    auditAction: 'workspace.deletion_restored',
    appliesTo: ({ status, restorable }) =>
      status === 'pending_deletion' && restorable,
  },
  reactivated: {
    auditAction: 'workspace.reactivated',
    appliesTo: ({ status }) => status === 'suspended',
  },
};

/**
 * Requests deletion of a workspace, restores it or lifts its suspension, in the
 * caller's workspace-scoped transaction. Deletion takes effect at once and the
 * workspace is purged after the recovery period; a repeated request with the
 * same idempotency key returns its first receipt.
 */
export async function changeWorkspaceLifecycle(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
): Promise<WorkspaceLifecycleOperation> {
  const db = drizzle(client);
  const [current] = await db
    .select({
      status: workspaces.status,
      restorable: sql<boolean>`coalesce(clock_timestamp()<${workspaces.purgeAfter},false)`,
    })
    .from(workspaces)
    .where(eq(workspaces.id, change.workspaceId))
    .for('update')
    .catch(rethrowQueryFailure);
  if (current === undefined)
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
    );
  const owner = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(workspaceMemberships, eq(workspaceMemberships.userId, users.id))
    .where(
      and(
        eq(users.id, change.actorUserId),
        eq(users.status, 'active'),
        eq(workspaceMemberships.workspaceId, change.workspaceId),
        eq(workspaceMemberships.status, 'active'),
        eq(workspaceMemberships.role, 'owner'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (owner.length !== 1)
    throw new WorkspaceLifecycleConflictError(
      'actor_inactive',
      'Workspace lifecycle actor is not authorized',
    );

  const prior = await readExistingOperation(client, change);
  if (prior !== undefined) return prior;

  if (!COMMANDS[change.commandType].appliesTo(current))
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
    );

  if (change.commandType === 'deletion_requested') {
    // One statement timestamp fixes the recovery window exactly.
    await db
      .update(workspaces)
      .set({
        status: 'pending_deletion',
        deletionRequestedAt: sql`statement_timestamp()`,
        deletionRequestedBy: change.actorUserId,
        deletionReason: change.reason,
        purgeAfter: sql`statement_timestamp()+make_interval(days=>${WORKSPACE_RECOVERY_DAYS})`,
        updatedAt: sql`statement_timestamp()`,
      })
      .where(eq(workspaces.id, change.workspaceId))
      .catch(rethrowQueryFailure);
    await applyDeletionSideEffects(
      client,
      change.workspaceId,
      change.actorUserId,
    );
  } else if (change.commandType === 'deletion_restored') {
    // A restore revives nothing by itself (ADR 013): the owner lifts the suspension.
    await db
      .update(workspaces)
      .set({
        status: 'suspended',
        deletionRequestedAt: null,
        deletionRequestedBy: null,
        deletionReason: null,
        purgeAfter: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workspaces.id, change.workspaceId))
      .catch(rethrowQueryFailure);
  } else {
    // Only the status moves: what deletion stopped stays off until re-enabled.
    await db
      .update(workspaces)
      .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
      .where(eq(workspaces.id, change.workspaceId))
      .catch(rethrowQueryFailure);
  }

  await appendAuditFact(client, {
    id: change.operationId,
    workspaceId: change.workspaceId,
    actorId: change.actorUserId,
    action: COMMANDS[change.commandType].auditAction,
    targetType: 'workspace',
    targetId: change.workspaceId,
  });
  const occurredAt = new Date();
  await drizzle(client, { schema: databaseSchema })
    .insert(workspaceLifecycleOperations)
    .values({
      id: change.operationId,
      workspaceId: change.workspaceId,
      idempotencyKeyHash: change.idempotencyKeyHash,
      commandType: change.commandType,
      actorUserId: change.actorUserId,
      reason: change.reason,
      requestHash: change.requestHash,
      occurredAt: occurredAt.toISOString(),
    });
  return Object.freeze({
    id: change.operationId,
    workspaceId: change.workspaceId,
    commandType: change.commandType,
    submittedAt: occurredAt,
  });
}

async function readExistingOperation(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
): Promise<WorkspaceLifecycleOperation | undefined> {
  const db = drizzle(client);
  const [prior] = await db
    .select({
      id: workspaceLifecycleOperations.id,
      workspaceId: workspaceLifecycleOperations.workspaceId,
      commandType: sql<WorkspaceLifecycleCommandType>`${workspaceLifecycleOperations.commandType}`,
      actorUserId: workspaceLifecycleOperations.actorUserId,
      reason: workspaceLifecycleOperations.reason,
      requestHash: workspaceLifecycleOperations.requestHash,
      submittedAt:
        sql<string>`${workspaceLifecycleOperations.occurredAt}`.mapWith(
          (value: string) => new Date(value),
        ),
    })
    .from(workspaceLifecycleOperations)
    .where(
      and(
        eq(workspaceLifecycleOperations.workspaceId, change.workspaceId),
        eq(
          workspaceLifecycleOperations.idempotencyKeyHash,
          change.idempotencyKeyHash,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  if (prior !== undefined) {
    const commandMismatch =
      prior.commandType !== change.commandType ||
      prior.actorUserId !== change.actorUserId ||
      prior.reason !== change.reason ||
      prior.requestHash !== change.requestHash;
    if (commandMismatch) throw new IdempotencyRequestConflictError();
    const { actorUserId, reason, requestHash, ...receipt } = prior;
    return Object.freeze(receipt);
  }

  return undefined;
}
