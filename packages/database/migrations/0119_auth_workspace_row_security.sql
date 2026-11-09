ALTER TABLE "app"."auth_directory_group_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."auth_organization_workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_scope ON app.auth_organization_workspaces TO {{app_role}}
 USING (workspace_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.workspace_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid END)
 WITH CHECK (workspace_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.workspace_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid END);

--> statement-breakpoint
CREATE POLICY workspace_scope ON app.auth_directory_group_mappings TO {{app_role}}
 USING (workspace_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.workspace_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid END)
 WITH CHECK (workspace_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.workspace_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid END);

--> statement-breakpoint
CREATE POLICY organization_scope ON app.auth_organization_workspaces TO {{app_role}}
 USING (organization_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.organization_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.organization_id', true), '')::uuid END)
 WITH CHECK (organization_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.organization_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.organization_id', true), '')::uuid END);

--> statement-breakpoint
CREATE POLICY organization_scope ON app.auth_directory_group_mappings TO {{app_role}}
 USING (organization_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.organization_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.organization_id', true), '')::uuid END)
 WITH CHECK (organization_id = CASE WHEN pg_catalog.pg_input_is_valid(NULLIF(pg_catalog.current_setting('app.organization_id', true), ''), 'uuid') THEN NULLIF(pg_catalog.current_setting('app.organization_id', true), '')::uuid END);
