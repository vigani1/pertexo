-- Hot execution/transport relations churn while retained history stays large.
-- Keep PostgreSQL's small-table thresholds; lower the size-proportional term.
ALTER TABLE app.workflow_runs SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
ALTER TABLE app.node_runs SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
ALTER TABLE app.node_attempts SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
ALTER TABLE app.run_checkpoints SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
ALTER TABLE app.run_events SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
ALTER TABLE app.outbox_events SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
ALTER TABLE app.inbox_receipts SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_insert_scale_factor=0.02);
