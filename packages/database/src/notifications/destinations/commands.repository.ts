import type { Role } from '@pertexo/workflow-model';
import {
  ADMINISTRATIVE_ROLES,
  WORKFLOW_EDITOR_ROLES,
} from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { auditEvents } from '../../schema/foundation.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.queries.js';
import type {
  CommandMetadata,
  DestinationAuditTarget,
  IdempotentCommandMetadata,
} from './contract.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  FailureNotificationDestinationError,
  type FailureNotificationDestinationErrorCode,
} from './errors.js';

/*
 * Transaction, idempotency, authorization and audit steps shared by the
 * destination commands and the workflow failure-notification policy.
 */

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
    idempotencyKey: input.idempotencyKey,
  };
}

/** Claims the command's key; a replay carries the stored result. */
export async function claimNotificationCommand(
  client: PoolClient,
  input: IdempotentCommandMetadata,
  {
    operation,
    scope,
    resourceId,
  }: Readonly<{ operation: string; scope: string; resourceId: string }>,
): Promise<
  Readonly<{ kind: 'new' }> | Readonly<{ kind: 'replay'; result: unknown }>
> {
  const stored = await claimCommand(client, {
    ...commandIdentity(input, operation, scope),
    requestHash: input.requestHash,
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
  {
    operation,
    scope,
    result,
  }: Readonly<{ operation: string; scope: string; result: unknown }>,
): Promise<void> {
  await completeCommand(client, commandIdentity(input, operation, scope), {
    result,
  });
}

export async function authorize(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  { manage }: Readonly<{ manage: boolean }>,
): Promise<void> {
  const roles: readonly Role[] = manage
    ? ADMINISTRATIVE_ROLES
    : WORKFLOW_EDITOR_ROLES;
  try {
    await lockWorkspaceAuthority(client, workspaceId, actorId, roles);
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw destinationError('not_found', 'Destination is not visible');
    throw error;
  }
}

export async function audit(
  client: PoolClient,
  input: CommandMetadata,
  {
    action,
    target,
    metadata,
  }: Readonly<{
    action: string;
    target: DestinationAuditTarget;
    metadata: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action,
      targetType: target.type,
      targetId: target.id,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata,
    })
    .catch(rethrowQueryFailure);
}
