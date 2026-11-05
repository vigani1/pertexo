-- These are security-integrity constraints, not application workflow policy.
COMMENT ON FUNCTION app.revoke_auth_sessions_for_email_change() IS
  'security integrity: holds for every writer. Keep session revocation atomic with an email change, including direct operator SQL and authentication-library writes. This trigger is the single owner of this rule.';
--> statement-breakpoint
COMMENT ON FUNCTION app.revoke_auth_sessions_for_inactive_user() IS
  'security integrity: holds for every writer. Keep session revocation atomic when an active global user becomes inactive, including direct operator SQL and authentication-library writes. This trigger is the single owner of this rule.';
--> statement-breakpoint
COMMENT ON FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() IS
  'security integrity: holds for every writer. Keep non-removed members session revocation atomic with workspace unavailability, including direct operator SQL. This trigger is the single owner of this rule.';
