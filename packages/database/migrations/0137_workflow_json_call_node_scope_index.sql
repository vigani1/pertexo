-- Online prerequisite for the exact inline-value node scope FK (ADR065).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS node_runs_native_value_scope_idx
  ON app.node_runs (workspace_id, workflow_run_id, id, node_id, invocation_key);
