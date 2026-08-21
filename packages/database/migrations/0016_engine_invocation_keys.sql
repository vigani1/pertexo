-- Phase 3 persists the workflow engine's canonical URI-component invocation
-- identity without hashing or translating it at the worker/database seam.
-- Retained Phase 0E rows keep their original bounded legacy identity.

ALTER TABLE app.node_runs
  DROP CONSTRAINT node_runs_invocation_key_format,
  ADD CONSTRAINT node_runs_invocation_key_format CHECK (
    invocation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'
    OR invocation_key ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'
  );
