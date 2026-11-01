import type { AuditMetadata } from '@pertexo/database/primitives';
import {
  appendAuditFact,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
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

/* Idempotency and audit steps shared by the destination commands and the workflow policy. */

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
    metadata: AuditMetadata;
  }>,
): Promise<void> {
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action,
    targetType: target.type,
    targetId: target.id,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata,
  });
}
