-- Expired receipts, sessions, sign-in records, invitations and authoring
-- leftovers are retention rules run by the maintenance role
-- (src/lifecycle/retention-rules.ts). The reaper functions, the replacement
-- claim scan cursor and the per-fact legal hold go; nothing places holds.

DROP FUNCTION app.reap_transient_data(integer);
DROP FUNCTION app.prune_manual_start_rejections(integer);
DROP FUNCTION app.reap_workspace_invitation_transients(integer);
DROP FUNCTION app.scan_workspace_invitation_replacement_claims(character varying, uuid, uuid, integer);
DROP FUNCTION app.minimize_terminal_workspace_invitation_pii(integer);
DROP FUNCTION app.prune_auth_email_evidence(integer);
DROP FUNCTION app.prune_authentication_mail(integer);
DROP FUNCTION app.prune_expired_auth_sessions(integer);
DROP FUNCTION app.prune_auth_method_link_attempts(integer);
DROP FUNCTION app.prune_auth_legacy_method_migration_attempts(integer);
DROP FUNCTION app.reap_workflow_input_cases(integer);
DROP FUNCTION app.reap_workflow_organization(integer);

DROP TABLE app.workspace_invitation_claim_cleanup_cursors;
ALTER TABLE app.identity_security_audit_facts DROP COLUMN legal_hold_until;

GRANT SELECT, DELETE ON app.sessions TO {{maintenance_role}};
GRANT SELECT, DELETE ON app.auth_sessions TO {{maintenance_role}};
GRANT SELECT, DELETE ON app.auth_method_link_attempts TO {{maintenance_role}};
GRANT SELECT, DELETE ON app.auth_legacy_method_migration_attempts
  TO {{maintenance_role}};
GRANT SELECT, DELETE ON app.auth_email_proofs TO {{maintenance_role}};
GRANT SELECT, DELETE ON app.identity_security_audit_facts TO {{maintenance_role}};
GRANT SELECT, DELETE ON app.authentication_mail_deliveries TO {{maintenance_role}};
GRANT UPDATE (status, payload_ciphertext, payload_nonce, payload_tag,
  payload_key_version, lease_owner, lease_token, lease_expires_at, completed_at,
  updated_at) ON app.authentication_mail_deliveries TO {{maintenance_role}};
GRANT UPDATE (status, delivery_status, recipient_email, normalized_email,
  updated_at) ON app.workspace_invitations TO {{maintenance_role}};
GRANT UPDATE (status, token_ciphertext, token_nonce, token_tag,
  token_key_version, updated_at)
  ON app.workspace_invitation_delivery_attempts TO {{maintenance_role}};
GRANT UPDATE (status, verified_user_id, verified_email, verified_at, updated_at)
  ON app.workspace_invitation_acceptance_intents TO {{maintenance_role}};
GRANT UPDATE (result_ref, updated_at)
  ON app.workspace_invitation_command_receipts TO {{maintenance_role}};
GRANT UPDATE (retired_at)
  ON app.workflow_favorite_membership_generations TO {{maintenance_role}};
