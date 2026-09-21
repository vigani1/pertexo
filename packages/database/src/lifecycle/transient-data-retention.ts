import type { Pool } from 'pg';
import { z } from 'zod';

import { inRetentionTransaction } from './retention-transaction.js';
import type { ParsedRetentionDatabaseOptions } from './retention-support.js';

export type TransientDataReapResult = Readonly<{
  invitationAcceptanceIntentsDeleted: number;
  invitationReplacementClaimsDeleted: number;
  invitationsExpired: number;
  idempotencyRecordsDeleted: number;
  invitationPiiMinimized: number;
  sessionsDeleted: number;
  workspaceCreationRecordsDeleted: number;
}>;

const deletedCountSchema = z.coerce.number().int().nonnegative();

export async function reapTransientData(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
  signal?: AbortSignal,
): Promise<TransientDataReapResult> {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const result = await client.query<{
      idempotency_records_deleted: number;
      invitation_acceptance_intents_deleted: number;
      invitation_replacement_claims_deleted: number;
      invitations_expired: number;
      invitation_pii_minimized: number;
      sessions_deleted: number;
      workspace_creation_records_deleted: number;
    }>({
      text: `select reaped.*,
        app.minimize_terminal_workspace_invitation_pii($1) invitation_pii_minimized,
        invitation_reaped.invitations_expired,
        invitation_reaped.acceptance_intents_deleted invitation_acceptance_intents_deleted,
        invitation_reaped.replacement_claims_deleted invitation_replacement_claims_deleted
        from app.reap_transient_data($1) reaped
        cross join app.reap_workspace_invitation_transients($1) invitation_reaped`,
      values: [options.pageSize],
    });
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Transient-data reaper result was not returned');
    return Object.freeze({
      invitationAcceptanceIntentsDeleted: deletedCountSchema.parse(
        row.invitation_acceptance_intents_deleted,
      ),
      invitationReplacementClaimsDeleted: deletedCountSchema.parse(
        row.invitation_replacement_claims_deleted,
      ),
      invitationsExpired: deletedCountSchema.parse(row.invitations_expired),
      idempotencyRecordsDeleted: deletedCountSchema.parse(
        row.idempotency_records_deleted,
      ),
      invitationPiiMinimized: deletedCountSchema.parse(
        row.invitation_pii_minimized,
      ),
      sessionsDeleted: deletedCountSchema.parse(row.sessions_deleted),
      workspaceCreationRecordsDeleted: deletedCountSchema.parse(
        row.workspace_creation_records_deleted,
      ),
    });
  });
}
