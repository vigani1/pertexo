import type { PoolClient } from 'pg';

import { cancelOpenInvitationDeliveries } from './delivery-cancellation.js';

type ExpirationScope = Readonly<
  | { workspaceId: string; invitationId: string; normalizedEmail?: never }
  | { workspaceId: string; normalizedEmail: string; invitationId?: never }
  | { workspaceId: string; invitationId?: never; normalizedEmail?: never }
>;

/** Invitation row first, then delivery and acceptance evidence in one transaction. */
export async function expireWorkspaceInvitations(
  client: PoolClient,
  scope: ExpirationScope,
): Promise<number> {
  const column =
    scope.invitationId !== undefined
      ? 'id'
      : scope.normalizedEmail !== undefined
        ? 'normalized_email'
        : undefined;
  const filter = column === undefined ? '' : `and ${column}=$2`;
  const qualifiedFilter =
    column === undefined ? '' : `and invitation.${column}=$2`;
  const values =
    scope.invitationId === undefined && scope.normalizedEmail === undefined
      ? [scope.workspaceId]
      : [scope.workspaceId, scope.invitationId ?? scope.normalizedEmail];
  const newlyExpired = await client.query<{ id: string }>(
    `update app.workspace_invitations
        set status='expired',delivery_status='canceled',updated_at=clock_timestamp()
      where workspace_id=$1 ${filter}
        and status='pending' and expires_at<=clock_timestamp()
      returning id`,
    values,
  );
  // Earlier expiration paths could leave open evidence behind. Retire that
  // evidence idempotently too, without rewriting terminal delivery history.
  const outstanding = await client.query<{ id: string }>(
    `select invitation.id
       from app.workspace_invitations invitation
      where invitation.workspace_id=$1 ${qualifiedFilter}
        and invitation.status='expired'
        and (
          exists (
            select 1 from app.workspace_invitation_delivery_attempts attempt
             where attempt.workspace_id=invitation.workspace_id
               and attempt.invitation_id=invitation.id
               and (attempt.status in ('queued','failed')
                 or (attempt.status='unknown' and attempt.token_ciphertext is not null))
          ) or exists (
            select 1 from app.workspace_invitation_acceptance_intents intent
             where intent.workspace_id=invitation.workspace_id
               and intent.invitation_id=invitation.id
               and intent.status in ('pending','verified','wrong_account')
          )
        )
      order by invitation.id for update of invitation`,
    values,
  );
  for (const invitationId of new Set(
    [...newlyExpired.rows, ...outstanding.rows].map(({ id }) => id).sort(),
  )) {
    await cancelOpenInvitationDeliveries(
      client,
      scope.workspaceId,
      invitationId,
    );
    await client.query(
      `update app.workspace_invitation_acceptance_intents
          set status='superseded',updated_at=clock_timestamp()
        where workspace_id=$1 and invitation_id=$2
          and status in ('pending','verified','wrong_account')`,
      [scope.workspaceId, invitationId],
    );
  }
  return newlyExpired.rowCount ?? 0;
}
