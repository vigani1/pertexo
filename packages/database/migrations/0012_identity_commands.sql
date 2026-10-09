-- Email proofs, the authentication mail queue, identity audit facts and the
-- OIDC sign-in capacity check run as plain statements in TypeScript
-- (apps/api/src/identity-infrastructure/owned-email-proofs.ts,
-- src/identity/authentication-mail.ts, src/tenant-access/oidc-login-transactions.ts).
-- Stale OIDC sign-in transactions are a retention rule. The triggers that
-- revoke sessions stay: Better Auth writes users and sessions too.

DROP FUNCTION app.issue_auth_email_proof(uuid, bytea, uuid, text, text, text, timestamp with time zone, uuid, text, timestamp with time zone, text, text, text, text);
DROP FUNCTION app.inspect_auth_email_proof(bytea);
DROP FUNCTION app.consume_auth_email_proof(bytea, uuid, bytea, timestamp with time zone, uuid, timestamp with time zone, text, text, text, text);
DROP FUNCTION app.enqueue_authentication_mail(uuid, text, timestamp with time zone, text, text, text, text);
DROP FUNCTION app.claim_authentication_mail(text, integer, uuid);
DROP FUNCTION app.settle_authentication_mail(uuid, uuid, bigint, text, text, text, timestamp with time zone);
DROP FUNCTION app.record_identity_profile_audit_fact(uuid);
DROP FUNCTION app.record_identity_method_audit_fact(uuid, text);
DROP TRIGGER oidc_login_transactions_capacity ON app.oidc_login_transactions;
DROP FUNCTION app.enforce_oidc_login_transaction_capacity();

GRANT SELECT, INSERT ON app.auth_email_proofs TO {{app_role}};
GRANT UPDATE (consumed_at) ON app.auth_email_proofs TO {{app_role}};
GRANT INSERT ON app.identity_security_audit_facts TO {{app_role}};
GRANT SELECT, INSERT ON app.authentication_mail_deliveries TO {{app_role}};
GRANT UPDATE (status, next_attempt_at, provider_reference, failure_code,
  payload_ciphertext, payload_nonce, payload_tag, payload_key_version,
  lease_owner, lease_token, lease_generation, lease_expires_at,
  attempt_count, completed_at, updated_at)
  ON app.authentication_mail_deliveries TO {{app_role}};
GRANT SELECT, DELETE ON app.oidc_login_transactions TO {{maintenance_role}};
