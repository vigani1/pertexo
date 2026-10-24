import { DELEGATED_ROLES } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../transactions.js';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';

const id = z.uuid();
const sealedToken = z
  .object({
    ciphertext: z.string().min(1).max(16_384),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();

export type WorkspaceInvitationDeliveryClaim =
  | Readonly<{ kind: 'terminal' }>
  | Readonly<{
      kind: 'ready';
      recoveredUnknown: boolean;
      email: string;
      workspaceName: string;
      role: string;
      expiresAt: Date;
      sealedToken: z.output<typeof sealedToken>;
    }>;

export interface WorkspaceInvitationDeliveryStore {
  claim(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      outboxEventId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<WorkspaceInvitationDeliveryClaim>;
  markDispatching(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<boolean>;
  retry(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<boolean>;
  complete(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      status: 'submitted' | 'failed';
      providerReference?: string;
      failureCode?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}

async function lockDeliveryScope(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
  deliveryAttemptId: string,
): Promise<void> {
  await client.query(
    `select id from app.workspace_invitations
      where workspace_id=$1 and id=$2 for update`,
    [workspaceId, invitationId],
  );
  await client.query(
    `select id from app.workspace_invitation_delivery_attempts
      where workspace_id=$1 and invitation_id=$2 and id=$3 for update`,
    [workspaceId, invitationId, deliveryAttemptId],
  );
}

export function createWorkspaceInvitationDeliveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInvitationDeliveryStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });

  return Object.freeze({
    claim: (raw: Parameters<WorkspaceInvitationDeliveryStore['claim']>[0]) =>
      claimInvitationDelivery(lease.pool, raw),
    markDispatching: (
      raw: Parameters<WorkspaceInvitationDeliveryStore['markDispatching']>[0],
    ) => markInvitationDeliveryDispatching(lease.pool, raw),
    retry: (raw: Parameters<WorkspaceInvitationDeliveryStore['retry']>[0]) =>
      retryInvitationDelivery(lease.pool, raw),
    complete: (
      raw: Parameters<WorkspaceInvitationDeliveryStore['complete']>[0],
    ) => completeInvitationDelivery(lease.pool, raw),
    close: () => lease.close(),
  });
}

function transaction<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal | undefined,
  operation: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedClient(
    pool,
    { workspaceId },
    operation,
    signal === undefined ? {} : { signal },
  );
}
async function claimInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['claim']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['claim']> {
  const workspaceId = id.parse(raw.workspaceId);
  const invitationId = id.parse(raw.invitationId);
  const deliveryAttemptId = id.parse(raw.deliveryAttemptId);
  const outboxEventId = id.parse(raw.outboxEventId);
  return transaction(pool, workspaceId, raw.signal, async (client) => {
    await assertInvitationDeliveryIdentity(client, {
      workspaceId,
      invitationId,
      outboxEventId,
    });
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const result = await client.query<{
      attempt_status: string;
      ciphertext: string | null;
      expires_at: Date;
      expired: boolean;
      invitation_revision: number;
      invitation_status: string;
      key_version: string | null;
      nonce: string | null;
      recipient_email: string;
      role: string;
      tag: string | null;
      workspace_name: string;
      workspace_status: string;
      current_revision: number;
    }>(
      `select attempt.status attempt_status,attempt.invitation_revision,
                  attempt.token_ciphertext ciphertext,attempt.token_nonce nonce,
                  attempt.token_tag tag,attempt.token_key_version key_version,
                  invitation.status invitation_status,invitation.revision current_revision,
                  invitation.recipient_email,invitation.role,invitation.expires_at,
                  invitation.expires_at<=clock_timestamp() expired,
                  attempt.workspace_name,workspace.status workspace_status
             from app.workspace_invitation_delivery_attempts attempt
             join app.workspace_invitations invitation
               on invitation.workspace_id=attempt.workspace_id and invitation.id=attempt.invitation_id
             join app.workspaces workspace on workspace.id=attempt.workspace_id
            where attempt.workspace_id=$1 and attempt.id=$2 and attempt.invitation_id=$3`,
      [workspaceId, deliveryAttemptId, invitationId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Workspace invitation delivery is unavailable');
    const invitationUnavailable =
      row.workspace_status !== 'active' ||
      row.invitation_status !== 'pending' ||
      row.invitation_revision !== row.current_revision ||
      row.expired ||
      ['submitted', 'failed', 'canceled'].includes(row.attempt_status);
    if (invitationUnavailable) {
      if (!['submitted', 'failed', 'canceled'].includes(row.attempt_status))
        await client.query(
          `update app.workspace_invitation_delivery_attempts
                  set status=case when status='queued' then 'canceled' else status end,
                      token_ciphertext=null,token_nonce=null,
                      token_tag=null,token_key_version=null,updated_at=clock_timestamp()
                where workspace_id=$1 and id=$2 and invitation_id=$3
                  and status in ('queued','unknown')`,
          [workspaceId, deliveryAttemptId, invitationId],
        );
      const mustExpireInvitation =
        row.invitation_status === 'pending' &&
        (row.expired || row.workspace_status !== 'active');
      if (mustExpireInvitation)
        await client.query(
          `update app.workspace_invitations
                  set delivery_status='canceled',updated_at=clock_timestamp()
                where workspace_id=$1 and id=$2 and delivery_status='queued'`,
          [workspaceId, invitationId],
        );
      return Object.freeze({ kind: 'terminal' as const });
    }
    const attemptUnavailable =
      !['queued', 'unknown'].includes(row.attempt_status) ||
      row.ciphertext === null ||
      row.nonce === null ||
      row.tag === null ||
      row.key_version === null;
    if (attemptUnavailable)
      throw new Error('Workspace invitation delivery state is invalid');
    return Object.freeze({
      kind: 'ready' as const,
      recoveredUnknown: row.attempt_status === 'unknown',
      email: z.email().max(320).parse(row.recipient_email),
      workspaceName: z.string().min(1).max(256).parse(row.workspace_name),
      role: z.enum(DELEGATED_ROLES).parse(row.role),
      expiresAt: z.coerce.date().parse(row.expires_at),
      sealedToken: sealedToken.parse({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.tag,
        keyVersion: row.key_version,
      }),
    });
  });
}

async function markInvitationDeliveryDispatching(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['markDispatching']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['markDispatching']> {
  const workspaceId = id.parse(raw.workspaceId);
  return transaction(pool, workspaceId, raw.signal, async (client) => {
    const invitationId = id.parse(raw.invitationId);
    const deliveryAttemptId = id.parse(raw.deliveryAttemptId);
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const result = await client.query(
      `update app.workspace_invitation_delivery_attempts
              set status='unknown',updated_at=clock_timestamp()
            where workspace_id=$1 and invitation_id=$2 and id=$3
              and status in ('queued','unknown')`,
      [workspaceId, invitationId, deliveryAttemptId],
    );
    return result.rowCount === 1;
  });
}

async function retryInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['retry']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['retry']> {
  const workspaceId = id.parse(raw.workspaceId);
  const invitationId = id.parse(raw.invitationId);
  const deliveryAttemptId = id.parse(raw.deliveryAttemptId);
  return transaction(pool, workspaceId, raw.signal, async (client) => {
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const result = await client.query(
      `update app.workspace_invitation_delivery_attempts attempt
           set status='queued', updated_at=clock_timestamp()
           from app.workspace_invitations invitation, app.workspaces workspace
           where attempt.workspace_id=$1 and attempt.invitation_id=$2 and attempt.id=$3
             and attempt.status in ('queued','unknown') and attempt.token_ciphertext is not null
             and invitation.workspace_id=attempt.workspace_id and invitation.id=attempt.invitation_id
             and invitation.status='pending' and invitation.expires_at>clock_timestamp()
             and invitation.revision=attempt.invitation_revision
             and workspace.id=attempt.workspace_id and workspace.status='active'`,
      [workspaceId, invitationId, deliveryAttemptId],
    );
    return result.rowCount === 1;
  });
}

async function completeInvitationDelivery(
  pool: Pool,
  raw: Parameters<WorkspaceInvitationDeliveryStore['complete']>[0],
): ReturnType<WorkspaceInvitationDeliveryStore['complete']> {
  const workspaceId = id.parse(raw.workspaceId);
  await transaction(pool, workspaceId, raw.signal, async (client) => {
    const invitationId = id.parse(raw.invitationId);
    const deliveryAttemptId = id.parse(raw.deliveryAttemptId);
    await lockDeliveryScope(
      client,
      workspaceId,
      invitationId,
      deliveryAttemptId,
    );
    const completed = await client.query(
      `update app.workspace_invitation_delivery_attempts
              set status=$4,provider_reference=$5,failure_code=$6,
                  token_ciphertext=null,token_nonce=null,token_tag=null,token_key_version=null,
                  updated_at=clock_timestamp()
            where workspace_id=$1 and invitation_id=$2 and id=$3
              and status in ('queued','unknown')`,
      [
        workspaceId,
        invitationId,
        deliveryAttemptId,
        raw.status,
        raw.providerReference ?? null,
        raw.failureCode ?? null,
      ],
    );
    if (completed.rowCount !== 1) return;
    await client.query(
      `update app.workspace_invitations
              set delivery_status=$3,updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2 and status='pending'
              and exists (
                select 1 from app.workspace_invitation_delivery_attempts attempt
                 where attempt.workspace_id=$1 and attempt.id=$4
                   and attempt.invitation_id=$2 and attempt.invitation_revision=workspace_invitations.revision
              )`,
      [workspaceId, invitationId, raw.status, deliveryAttemptId],
    );
  });
}

async function assertInvitationDeliveryIdentity(
  client: PoolClient,
  {
    workspaceId,
    invitationId,
    outboxEventId,
  }: Readonly<{
    workspaceId: string;
    invitationId: string;
    outboxEventId: string;
  }>,
): Promise<void> {
  const authoritative = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
  }>(
    `select aggregate_id,aggregate_type,job_name,payload,payload_checksum
             from app.outbox_events where workspace_id=$1 and id=$2`,
    [workspaceId, outboxEventId],
  );
  const outbox = authoritative.rows[0];
  const checksum =
    outbox === undefined
      ? undefined
      : createHash('sha256')
          .update(serializeStoredExecutionJsonValue(outbox.payload))
          .digest('hex');
  const invalidDelivery =
    outbox?.aggregate_id !== invitationId ||
    outbox.aggregate_type !== 'workspace-invitation' ||
    outbox.job_name !== 'deliver-workspace-invitation' ||
    outbox.payload_checksum !== checksum;
  if (invalidDelivery)
    throw new Error('Workspace invitation delivery identity mismatch');
}
