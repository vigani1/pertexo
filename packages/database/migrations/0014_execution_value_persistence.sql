-- EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1 = 4194304. This is a coarse
-- whole-jsonb storage guard, not the exact 262144-byte canonical inline-value
-- limit. It includes the V1 wrapper and conservative allowance for PostgreSQL
-- jsonb::text whitespace and numeric exponent expansion across 10000 members.

ALTER TABLE app.workflow_runs
  ADD COLUMN input_ref jsonb,
  ADD CONSTRAINT workflow_runs_input_ref_bounded
    CHECK (input_ref IS NULL OR octet_length(input_ref::text) <= 4194304),
  DROP CONSTRAINT workflow_runs_output_ref_bounded,
  ADD CONSTRAINT workflow_runs_output_ref_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4194304);

ALTER TABLE app.run_checkpoints
  DROP CONSTRAINT run_checkpoints_scheduler_state_bounded,
  ADD CONSTRAINT run_checkpoints_scheduler_state_bounded
    CHECK (octet_length(scheduler_state::text) <= 4194304);

ALTER TABLE app.node_runs
  DROP CONSTRAINT node_runs_input_ref_bounded,
  ADD CONSTRAINT node_runs_input_ref_bounded
    CHECK (input_ref IS NULL OR octet_length(input_ref::text) <= 4194304),
  DROP CONSTRAINT node_runs_output_ref_bounded,
  ADD CONSTRAINT node_runs_output_ref_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4194304);

ALTER TABLE app.node_attempts
  DROP CONSTRAINT node_attempts_output_ref_bounded,
  ADD CONSTRAINT node_attempts_output_ref_bounded
    CHECK (output_ref IS NULL OR octet_length(output_ref::text) <= 4194304);
