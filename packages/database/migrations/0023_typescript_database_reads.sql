-- Admission explanations are typed workspace reads, not elevated functions.
GRANT SELECT ON app.workflow_run_active_admissions TO {{app_role}};
CREATE POLICY workflow_run_active_admissions_workspace_scope
  ON app.workflow_run_active_admissions FOR SELECT TO {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));

DROP FUNCTION app.workflow_run_admission_blockers(uuid, uuid);
DROP FUNCTION app.workspace_reserved_active_slot_count(uuid);

-- Maintenance owns the same sorted binding locks and bounded lineage check
-- in TypeScript for both retention and workspace purge.
DROP FUNCTION app.workspace_invitation_replacement_claim_is_reapable(uuid, uuid, character);
