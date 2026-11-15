import type { PoolClient } from 'pg';
import { appendAuditFact } from '../../governance/audit/facts.js';
import { IdempotencyRequestConflictError } from '../../shared/command-receipt.errors.js';
import { WorkspaceLifecycleConflictError } from '../workspace-lifecycle.errors.js';
import type {
  WorkspaceLifecycleOperation,
  WorkspaceLifecycleChange,
} from './workspace-lifecycle.types.js';
import { LIFECYCLE_TRANSITIONS } from './transitions.js';
import {
  applyDeletionSideEffects,
  insertLifecycleOperation,
  markDeletionRequested,
  markDeletionRestored,
  markWorkspaceActive,
  readExistingOperation,
  readWorkspaceStanding,
} from './apply.repository.js';

/**
 * Requests deletion of a workspace, restores it or lifts its suspension, in a
 * transaction that already holds the workspace row and the owner's authority
 * (`changeWorkspaceLifecycle`). Deletion takes effect at once and the workspace
 * is purged after the recovery period; a repeated request with the same
 * idempotency key returns its first receipt.
 */
export async function applyWorkspaceLifecycleChange(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
): Promise<WorkspaceLifecycleOperation> {
  const current = await readWorkspaceStanding(client, change.workspaceId);
  if (current === undefined)
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
    );
  const prior = await replayExistingOperation(client, change);
  if (prior !== undefined) return prior;

  if (!LIFECYCLE_TRANSITIONS[change.commandType].appliesTo(current))
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
    );

  if (change.commandType === 'deletion_requested') {
    await markDeletionRequested(client, change);
    await applyDeletionSideEffects(
      client,
      change.workspaceId,
      change.actorUserId,
    );
  } else if (change.commandType === 'deletion_restored') {
    // A restore revives nothing by itself (ADR 013): the owner lifts the suspension.
    await markDeletionRestored(client, change.workspaceId);
  } else {
    // Only the status moves: what deletion stopped stays off until re-enabled.
    await markWorkspaceActive(client, change.workspaceId);
  }

  await appendAuditFact(client, {
    id: change.operationId,
    workspaceId: change.workspaceId,
    actorId: change.actorUserId,
    action: LIFECYCLE_TRANSITIONS[change.commandType].auditAction,
    targetType: 'workspace',
    targetId: change.workspaceId,
  });
  const occurredAt = new Date();
  await insertLifecycleOperation(client, change, occurredAt);
  return Object.freeze({
    id: change.operationId,
    workspaceId: change.workspaceId,
    commandType: change.commandType,
    submittedAt: occurredAt,
  });
}

async function replayExistingOperation(
  client: PoolClient,
  change: WorkspaceLifecycleChange,
): Promise<WorkspaceLifecycleOperation | undefined> {
  const prior = await readExistingOperation(client, change);
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
