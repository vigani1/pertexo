import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaceInvitationDeliveryAttempts as attempts,
  workspaces,
  auditEvents,
} from '../../../schema/foundation.js';
import { outboxEvents } from '../../../schema/transport.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import type { CommandIdentity } from '../../../platform/idempotency/contract.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import type {
  WorkspaceInvitationCommandResult,
  WorkspaceInvitationRecord,
} from '../../contract.js';

import type { sealedToken } from '../input.js';
import { idempotencyKey } from '../input.js';
import { durableResult } from './receipt.js';
import { serializeInvitation, mapDurableInvitation } from './receipt.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** An invitation command's key, per actor and workspace. */
export function invitationKey(
  workspaceId: string,
  actorUserId: string,
  operation: 'create' | 'resend' | 'revoke',
  key: string,
): CommandIdentity {
  return {
    workspaceId,
    operation: `workspace.invitation.${operation}`,
    scope: actorUserId,
    idempotencyKey: idempotencyKey.parse(key),
  };
}

/** Claims the key; returns the invitation an exact retry replays. */
export async function claimInvitationCommand(
  client: PoolClient,
  key: CommandIdentity,
  request: Record<string, unknown>,
  invitationId: string,
): Promise<WorkspaceInvitationCommandResult | null> {
  const stored = await claimCommand(client, {
    ...key,
    request,
    resourceId: invitationId,
  });
  if (stored === null) return null;
  return Object.freeze({
    invitation: mapDurableInvitation(durableResult.parse(stored).invitation),
    replayed: true,
  });
}

export async function completeInvitationCommand(
  client: PoolClient,
  key: CommandIdentity,
  invitation: WorkspaceInvitationRecord,
): Promise<WorkspaceInvitationCommandResult> {
  await completeCommand(client, key, {
    invitation: serializeInvitation(invitation),
  });
  return Object.freeze({ invitation, replayed: false });
}

export async function insertDelivery(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    invitationId: string;
    revision: number;
    deliveryAttemptId: string;
    sealed: z.output<typeof sealedToken>;
  }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .insert(attempts)
    .select(
      db
        .select({
          id: sql<string>`${input.deliveryAttemptId}::uuid`.as('id'),
          workspaceId: sql<string>`${input.workspaceId}::uuid`.as(
            'workspace_id',
          ),
          invitationId: sql<string>`${input.invitationId}::uuid`.as(
            'invitation_id',
          ),
          invitationRevision: sql<number>`${input.revision}::integer`.as(
            'invitation_revision',
          ),
          status: sql<string>`'queued'`.as('status'),
          tokenCiphertext: sql<string>`${input.sealed.ciphertext}::text`.as(
            'token_ciphertext',
          ),
          tokenNonce: sql<string>`${input.sealed.nonce}::text`.as(
            'token_nonce',
          ),
          tokenTag: sql<string>`${input.sealed.tag}::text`.as('token_tag'),
          tokenKeyVersion: sql<string>`${input.sealed.keyVersion}::text`.as(
            'token_key_version',
          ),
          workspaceName: workspaces.name,
          providerReference: sql<null>`null`.as('provider_reference'),
          failureCode: sql<null>`null`.as('failure_code'),
          createdAt: sql<Date>`clock_timestamp()`.as('created_at'),
          updatedAt: sql<Date>`clock_timestamp()`.as('updated_at'),
        })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId)),
    )
    .catch(rethrowQueryFailure);
  const outboxEventId = generatePersistedId();
  const payload = {
    deliveryAttemptId: input.deliveryAttemptId,
    invitationId: input.invitationId,
    outboxEventId,
    workspaceId: input.workspaceId,
  };
  const payloadJson = canonicalJson(payload);
  await db
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'deliver-workspace-invitation',
      aggregateType: 'workspace-invitation',
      aggregateId: input.invitationId,
      payload: sql`${payloadJson}::jsonb`,
      payloadChecksum: sha256(payloadJson),
    })
    .catch(rethrowQueryFailure);
}

export async function recordAudit(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    invitationId: string;
    action: string;
    revision: number;
    role: string;
    requestId?: string;
    traceId?: string;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: 'workspace_invitation',
      targetId: input.invitationId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: { revision: input.revision, role: input.role },
    })
    .catch(rethrowQueryFailure);
}
