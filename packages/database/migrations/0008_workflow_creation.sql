-- Creating, duplicating and importing a workflow runs in TypeScript
-- (src/authoring/), which validates the command once and writes the rows.
-- The SQL copies that re-validated imports and re-checked authority go.
-- Curated templates live in code (@pertexo/workflow-model/curated-templates),
-- so the database copy of them goes, with the import rollout switches.

DROP FUNCTION app.create_workflow_with_draft(uuid, uuid, character varying, uuid, integer, jsonb, character, character, character varying, character varying);
DROP FUNCTION app.create_workflow_duplicate_draft(uuid, uuid, uuid, uuid, character varying, integer, jsonb, character, character, text, uuid);
DROP FUNCTION app.create_workflow_import_draft(uuid, uuid, uuid, jsonb, character, character, text);
DROP FUNCTION app.lock_workflow_portable_version(uuid, uuid, uuid, uuid);
DROP FUNCTION app.verify_curated_template_origin(jsonb, jsonb, text);
DROP FUNCTION app.lock_curated_template_descriptor(text, integer);
DROP FUNCTION app.curated_template_inventory_matches(text);
DROP FUNCTION app.curated_https_endpoint_valid(text);

DROP TABLE app.curated_template_descriptors;
DROP FUNCTION app.guard_curated_template_descriptor();
DROP TABLE app.curated_template_rollout;
DROP TABLE app.workflow_portability_rollout;

GRANT INSERT ON app.workflows, app.workflow_drafts TO {{app_role}};

DROP POLICY workflow_template_origins_tenant ON app.workflow_template_origins;
CREATE POLICY workflow_template_origins_workspace_scope
  ON app.workflow_template_origins TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
GRANT INSERT ON app.workflow_template_origins TO {{app_role}};
