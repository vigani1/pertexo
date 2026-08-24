ALTER TABLE app.node_runs
  ADD COLUMN control_kind varchar(32),
  ADD CONSTRAINT node_runs_control_kind_valid CHECK (
    control_kind IS NULL OR control_kind = 'for_each_barrier'
  );

ALTER TABLE app.node_runs
  DROP CONSTRAINT node_runs_wait_state_valid,
  ADD CONSTRAINT node_runs_wait_state_valid CHECK (
    (
      status = 'waiting'
      AND control_kind = 'for_each_barrier'
      AND resume_at IS NULL
      AND retry_due_at IS NULL
    ) OR (
      status = 'waiting'
      AND control_kind IS NULL
      AND (resume_at IS NOT NULL OR retry_due_at IS NOT NULL)
    ) OR (
      status <> 'waiting'
      AND control_kind IS NULL
      AND resume_at IS NULL
      AND retry_due_at IS NULL
    )
  );

GRANT UPDATE (control_kind) ON app.node_runs TO {{worker_runtime_role}};
