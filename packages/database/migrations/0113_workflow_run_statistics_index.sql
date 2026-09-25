-- Covering index for the bounded run-statistics read (ADR 044). One
-- workspace-scoped created_at range yields status and workflow counts from
-- the index alone, without visiting runs outside the window.
CREATE INDEX workflow_runs_workspace_created_statistics_idx
  ON app.workflow_runs (workspace_id, created_at)
  INCLUDE (status, workflow_id);
