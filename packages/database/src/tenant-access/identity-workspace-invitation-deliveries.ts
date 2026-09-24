import type { PoolClient } from 'pg';

/**
 * Stops every unresolved delivery attempt of one invitation and scrubs its
 * sealed token. Queued and failed attempts become canceled; an attempt whose
 * provider outcome is unknown keeps that status for reconciliation but can no
 * longer be delivered because its token is gone.
 */
export async function cancelOpenInvitationDeliveries(
  client: PoolClient,
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  await client.query(
    `update app.workspace_invitation_delivery_attempts
        set status=case when status in ('queued','failed') then 'canceled' else status end,
            token_ciphertext=null,token_nonce=null,token_tag=null,
            token_key_version=null,updated_at=clock_timestamp()
      where workspace_id=$1 and invitation_id=$2
        and status in ('queued','failed','unknown')`,
    [workspaceId, invitationId],
  );
}
