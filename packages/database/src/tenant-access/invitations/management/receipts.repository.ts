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

import type { sealedToken } from './contract.js';
import { idempotencyKey, durableResult } from './contract.js';
import { serializeInvitation, mapDurableInvitation } from './state.queries.js';

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
  await client.query(
    `insert into app.workspace_invitation_delivery_attempts
       (id,workspace_id,invitation_id,invitation_revision,status,
        token_ciphertext,token_nonce,token_tag,token_key_version,workspace_name)
     select $1,$2,$3,$4,'queued',$5,$6,$7,$8,workspace.name
       from app.workspaces workspace where workspace.id=$2`,
    [
      input.deliveryAttemptId,
      input.workspaceId,
      input.invitationId,
      input.revision,
      input.sealed.ciphertext,
      input.sealed.nonce,
      input.sealed.tag,
      input.sealed.keyVersion,
    ],
  );
  const outboxEventId = generatePersistedId();
  const payload = {
    deliveryAttemptId: input.deliveryAttemptId,
    invitationId: input.invitationId,
    outboxEventId,
    workspaceId: input.workspaceId,
  };
  const payloadJson = canonicalJson(payload);
  await client.query(
    `insert into app.outbox_events
       (id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum)
     values($1,$2,'deliver-workspace-invitation','workspace-invitation',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      input.workspaceId,
      input.invitationId,
      payloadJson,
      sha256(payloadJson),
    ],
  );
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
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values($1,$2,$3,$4,'workspace_invitation',$5,$6,$7,$8::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorUserId,
      input.action,
      input.invitationId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify({ revision: input.revision, role: input.role }),
    ],
  );
}
