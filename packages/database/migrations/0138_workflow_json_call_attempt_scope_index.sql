-- Online prerequisite for the exact inline-value attempt scope FK (ADR065).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS node_attempts_native_value_scope_idx
  ON app.node_attempts (workspace_id, node_run_id, id, attempt_number);
