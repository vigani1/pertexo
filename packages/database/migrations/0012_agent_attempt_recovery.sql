-- A lost model dispatch is a failed attempt awaiting the ordinary retry decision.
GRANT UPDATE (safe_error_code, executor_failure_kind, executor_error_kind,
  executor_possibly_dispatched, retry_decision)
  ON app.node_attempts TO {{maintenance_role}};
