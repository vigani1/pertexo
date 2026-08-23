-- Provider idempotency keys belong only to idempotent-with-key logical nodes
-- and attempts. Keep the database invariant aligned with engine admission.

ALTER TABLE app.node_attempts
  DROP CONSTRAINT node_attempts_provider_key_valid,
  ADD CONSTRAINT node_attempts_provider_key_valid
    CHECK (
      (side_effect_class = 'idempotent_with_key') =
      (provider_idempotency_key IS NOT NULL)
    );

ALTER TABLE app.node_runs
  DROP CONSTRAINT node_runs_provider_key_valid,
  ADD CONSTRAINT node_runs_provider_key_valid
    CHECK (
      (side_effect_class = 'idempotent_with_key') =
      (provider_idempotency_key IS NOT NULL)
    );
