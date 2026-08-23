ALTER TABLE app.node_attempts
  ADD COLUMN executor_failure_kind varchar(32),
  ADD COLUMN executor_error_kind varchar(32),
  ADD COLUMN executor_possibly_dispatched boolean,
  ADD COLUMN retry_decision varchar(32),
  ADD CONSTRAINT node_attempts_executor_failure_complete
    CHECK (
      (executor_failure_kind IS NULL AND executor_error_kind IS NULL
       AND executor_possibly_dispatched IS NULL AND retry_decision IS NULL)
      OR
      (executor_failure_kind IS NOT NULL AND executor_error_kind IS NOT NULL
       AND executor_possibly_dispatched IS NOT NULL AND retry_decision IS NOT NULL)
    ),
  ADD CONSTRAINT node_attempts_executor_failure_kind_valid
    CHECK (executor_failure_kind IS NULL OR executor_failure_kind IN
      ('failed','canceled','retry','outcome_unknown')),
  ADD CONSTRAINT node_attempts_executor_error_kind_valid
    CHECK (executor_error_kind IS NULL OR executor_error_kind IN
      ('authentication','canceled','configuration','internal','network',
       'provider','rate_limit','timeout')),
  ADD CONSTRAINT node_attempts_retry_decision_valid
    CHECK (retry_decision IS NULL OR retry_decision IN
      ('pending','retry','failed','canceled','timed_out','outcome_unknown')),
  ADD CONSTRAINT node_attempts_executor_failure_only_failed
    CHECK (executor_failure_kind IS NULL OR status = 'failed');

GRANT UPDATE (
  executor_failure_kind, executor_error_kind,
  executor_possibly_dispatched, retry_decision
) ON app.node_attempts TO {{worker_runtime_role}};
