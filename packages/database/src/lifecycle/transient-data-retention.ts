import type { Pool } from 'pg';
import { z } from 'zod';

import { inRetentionTransaction } from './retention-transaction.js';
import type { ParsedRetentionDatabaseOptions } from './retention-support.js';

export type TransientDataReapResult = Readonly<{
  authenticationMailDeleted: number;
  authenticationMailExpired: number;
  authenticationProofsDeleted: number;
  authenticationLinkAttemptsDeleted: number;
  authenticationLegacyAttemptsDeleted: number;
  identitySecurityAuditDeleted: number;
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
      auth_sessions_deleted: number;
      authentication_mail_deleted: number;
      authentication_mail_expired: number;
      authentication_proofs_deleted: number;
      authentication_link_attempts_deleted: number;
      authentication_legacy_attempts_deleted: number;
      identity_security_audit_deleted: number;
      invitation_acceptance_intents_deleted: number;
      invitation_replacement_claims_deleted: number;
      invitations_expired: number;
      invitation_pii_minimized: number;
      sessions_deleted: number;
      workspace_creation_records_deleted: number;
    }>({
      text: `select reaped.*,
        app.prune_expired_auth_sessions($1) auth_sessions_deleted,
        auth_mail.deleted authentication_mail_deleted,
        auth_mail.expired authentication_mail_expired,
        auth_proofs.proofs_deleted authentication_proofs_deleted,
        app.prune_auth_method_link_attempts($1) authentication_link_attempts_deleted,
        app.prune_auth_legacy_method_migration_attempts($1) authentication_legacy_attempts_deleted,
        auth_proofs.audit_deleted identity_security_audit_deleted,
        app.minimize_terminal_workspace_invitation_pii($1) invitation_pii_minimized,
        invitation_reaped.invitations_expired,
        invitation_reaped.acceptance_intents_deleted invitation_acceptance_intents_deleted,
        invitation_reaped.replacement_claims_deleted invitation_replacement_claims_deleted
        from app.reap_transient_data($1) reaped
        cross join app.reap_workspace_invitation_transients($1) invitation_reaped
        cross join app.prune_authentication_mail($1) auth_mail
        cross join app.prune_auth_email_evidence($1) auth_proofs`,
      values: [options.pageSize],
    });
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Transient-data reaper result was not returned');
    return Object.freeze({
      authenticationMailDeleted: deletedCountSchema.parse(
        row.authentication_mail_deleted,
      ),
      authenticationMailExpired: deletedCountSchema.parse(
        row.authentication_mail_expired,
      ),
      authenticationProofsDeleted: deletedCountSchema.parse(
        row.authentication_proofs_deleted,
      ),
      authenticationLinkAttemptsDeleted: deletedCountSchema.parse(
        row.authentication_link_attempts_deleted,
      ),
      authenticationLegacyAttemptsDeleted: deletedCountSchema.parse(
        row.authentication_legacy_attempts_deleted,
      ),
      identitySecurityAuditDeleted: deletedCountSchema.parse(
        row.identity_security_audit_deleted,
      ),
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
      sessionsDeleted:
        deletedCountSchema.parse(row.sessions_deleted) +
        deletedCountSchema.parse(row.auth_sessions_deleted),
      workspaceCreationRecordsDeleted: deletedCountSchema.parse(
        row.workspace_creation_records_deleted,
      ),
    });
  });
}
