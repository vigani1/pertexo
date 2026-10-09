-- Better Auth is the only browser-session authority (ADR 039, ADR 069). The
-- generic OIDC sign-in, its opaque sessions, the legacy identities they
-- mapped and the method-migration bridge from them go before launch.

DROP TABLE app.auth_legacy_method_migration_attempts;
DROP TABLE app.oidc_login_transactions;
DROP TABLE app.sessions;
DROP TABLE app.auth_identities;

DELETE FROM app.identity_security_audit_facts
 WHERE event_type = 'legacy.method_migrated';
ALTER TABLE app.identity_security_audit_facts
  DROP CONSTRAINT identity_security_audit_event_valid,
  ADD CONSTRAINT identity_security_audit_event_valid CHECK (
    (event_type)::text = ANY (ARRAY[
      'email.initial_verified', 'email.old_confirmed', 'email.change_verified',
      'method.linked', 'method.unlinked', 'password.changed',
      'password.configured', 'password.reset', 'profile.display_name_changed'
    ]::text[])
  );
