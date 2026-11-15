import { cancelUndispatchedWorkspacePreviews } from '../../previews/attempts/cancel-workspace-previews.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type {
  WorkspaceLifecycleCommandType,
  WorkspaceLifecycleChange,
} from './workspace-lifecycle.types.js';
import { deleteWorkspaceOAuth2Grants } from '../../connections/oauth2/clients.repository.js';
import {
  connections,
  apiTokens,
  webhookTriggerEndpoints,
  triggerSchedules,
  workflowTriggers,
  workflows,
  failureNotificationDestinations,
  workspaceInvitations,
  workspaceInvitationDeliveryAttempts,
  workspaceInvitationAcceptanceIntents,
  workspaces,
  workspaceLifecycleOperations,
  databaseSchema,
} from '@pertexo/database/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { requestActiveRunCancellations } from '../../runs/commands/cancel-run.js';
import type { WorkspaceId } from '@pertexo/database/primitives';
import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';

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
export async function applyDeletionSideEffects(
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
  await cancelUndispatchedWorkspacePreviews(client, workspaceId);
  await requestActiveRunCancellations(
    Object.freeze({
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: workspaceId as WorkspaceId,
    }),
    { actorId: actorUserId, reason: 'Workspace deletion requested' },
  );
}

/** The workspace's status and whether its recovery window is still open. */
export async function readWorkspaceStanding(
  client: PoolClient,
  workspaceId: string,
) {
  const [current] = await drizzle(client)
    .select({
      status: workspaces.status,
      restorable: sql<boolean>`coalesce(clock_timestamp()<${workspaces.purgeAfter},false)`,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  return current;
}

export async function markDeletionRequested(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
): Promise<void> {
  // One statement timestamp fixes the recovery window exactly.
  await drizzle(client)
    .update(workspaces)
    .set({
      status: 'pending_deletion',
      deletionRequestedAt: sql`statement_timestamp()`,
      deletionRequestedBy: change.actorUserId,
      deletionReason: change.reason,
      purgeAfter: sql`statement_timestamp()+make_interval(days=>${DATA_RETENTION_DAYS.workspaceRecovery})`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(eq(workspaces.id, change.workspaceId))
    .catch(rethrowQueryFailure);
}

export async function markDeletionRestored(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .update(workspaces)
    .set({
      status: 'suspended',
      deletionRequestedAt: null,
      deletionRequestedBy: null,
      deletionReason: null,
      purgeAfter: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
}

export async function markWorkspaceActive(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .update(workspaces)
    .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
}

export async function insertLifecycleOperation(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
  occurredAt: Date,
): Promise<void> {
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
}

/** The earlier operation under this idempotency key, with what it was asked. */
export async function readExistingOperation(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
) {
  const [prior] = await drizzle(client)
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
  return prior;
}
