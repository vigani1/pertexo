CREATE INDEX workflow_runs_workspace_created_idx
  ON app.workflow_runs (workspace_id, created_at, id);

CREATE INDEX workflow_runs_workspace_workflow_created_idx
  ON app.workflow_runs (workspace_id, workflow_id, created_at, id);
