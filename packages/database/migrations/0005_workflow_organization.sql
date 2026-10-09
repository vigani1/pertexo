-- Folder, tag and placement commands run in TypeScript
-- (src/authoring/organization). An advisory lock per workspace orders
-- organization writes, and command keys live in idempotency_records. The app
-- role writes the organization tables in its own workspace, as it does
-- workflows; the commands check the actor's role first.

DROP FUNCTION app.admit_workflow_organization_batch(text, jsonb);
DROP FUNCTION app.execute_workflow_organization_batch_item(text, jsonb, uuid, text);
DROP FUNCTION app.execute_workflow_folder_command(text, uuid, text, jsonb);
DROP FUNCTION app.execute_workflow_folder_placement(uuid, text, jsonb);
DROP FUNCTION app.execute_workflow_tag_command(text, uuid, text, jsonb);
DROP FUNCTION app.execute_workflow_tag_assignment_command(text, uuid, text, jsonb);
DROP FUNCTION app.apply_workflow_organization_item(text, uuid, jsonb);
DROP FUNCTION app.claim_workflow_organization_command(text, uuid, text, jsonb);
DROP FUNCTION app.complete_workflow_organization_command(text, uuid, text, jsonb);
DROP FUNCTION app.record_workflow_organization_audit(text, uuid, jsonb);
DROP FUNCTION app.lock_workflow_organization_for_lifecycle();
DROP FUNCTION app.workflow_folder_command_body(text, jsonb);
DROP FUNCTION app.workflow_folder_depth(uuid, uuid);
DROP FUNCTION app.workflow_organization_batch_body(jsonb);
DROP FUNCTION app.workflow_organization_revision(jsonb);
DROP FUNCTION app.workflow_organization_uuid(jsonb, boolean);

DROP TABLE app.workflow_organization_receipts;

DROP POLICY workflow_folders_reader ON app.workflow_folders;
DROP POLICY workflow_tags_reader ON app.workflow_tags;
DROP POLICY workflow_tag_assignments_reader ON app.workflow_tag_assignments;
DROP POLICY workflow_organization_state_reader ON app.workflow_organization_state;

CREATE POLICY workflow_folders_workspace_scope ON app.workflow_folders
  TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_tags_workspace_scope ON app.workflow_tags
  TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_tag_assignments_workspace_scope ON app.workflow_tag_assignments
  TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_organization_state_workspace_scope ON app.workflow_organization_state
  TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));

GRANT INSERT, DELETE ON app.workflow_folders TO {{app_role}};
GRANT UPDATE (parent_id, name, name_key, revision)
  ON app.workflow_folders TO {{app_role}};
GRANT INSERT, DELETE ON app.workflow_tags TO {{app_role}};
GRANT UPDATE (key, revision) ON app.workflow_tags TO {{app_role}};
GRANT INSERT, DELETE ON app.workflow_tag_assignments TO {{app_role}};
GRANT INSERT ON app.workflow_organization_state TO {{app_role}};
GRANT UPDATE (revision, folder_id)
  ON app.workflow_organization_state TO {{app_role}};
