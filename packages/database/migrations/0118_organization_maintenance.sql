-- Organization commands and provisioning retain their multi-workspace transaction.
GRANT SELECT, INSERT, UPDATE, DELETE ON
 app.auth_organizations, app.auth_organization_workspaces, app.auth_domains,
 app.auth_providers, app.auth_provider_checks, app.auth_federation_attempts,
 app.auth_directory_users, app.auth_directory_groups, app.auth_directory_group_members,
 app.auth_directory_group_mappings, app.auth_directory_memberships, app.auth_provisioning_credentials
TO {{maintenance_role}};
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(id) ON app.users TO {{maintenance_role}};
GRANT INSERT ON app.auth_sessions, app.workspace_memberships TO {{maintenance_role}};
--> statement-breakpoint
-- Preserve the existing ban on maintenance reading credential hashes.
GRANT SELECT(user_id,account_id), INSERT, UPDATE(id) ON app.auth_accounts TO {{maintenance_role}};
--> statement-breakpoint
GRANT INSERT ON app.identity_security_audit_facts TO {{maintenance_role}};
--> statement-breakpoint
-- Isolation lookup: the locked identity flow receives presence, never credential material.
CREATE FUNCTION app.password_credential_count(p_user_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT pg_catalog.count(*)::integer FROM app.auth_accounts AS account
 WHERE account.user_id = p_user_id AND account.provider_id = 'credential'
   AND account.password IS NOT NULL AND pg_catalog.length(account.password) > 0;
$$;
--> statement-breakpoint
ALTER FUNCTION app.password_credential_count(uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.password_credential_count(uuid) FROM PUBLIC, {{app_role}};
GRANT EXECUTE ON FUNCTION app.password_credential_count(uuid) TO {{maintenance_role}};
