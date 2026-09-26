-- Record each step's resolved input (ADR 052). The worker writes the input an
-- attempt's executor receives onto its node run, under the attempt's lease.
-- The column, its size bound, artifact lock and retention already exist.

GRANT UPDATE (input_ref) ON app.node_runs TO {{worker_runtime_role}};
