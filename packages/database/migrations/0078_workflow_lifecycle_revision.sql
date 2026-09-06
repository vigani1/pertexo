-- ADR 034: workflow lifecycle commands use an aggregate-owned revision that is
-- independent from draft revision, publication, and activation convergence.

ALTER TABLE app.workflows
  ADD COLUMN lifecycle_revision integer NOT NULL DEFAULT 1;

ALTER TABLE app.workflows
  ADD CONSTRAINT workflows_lifecycle_revision_positive
  CHECK (lifecycle_revision > 0);

-- The API runtime may advance this one command-owned field. It cannot change
-- workflow identity, creation metadata, or the published pointer through the
-- lifecycle command seam.
GRANT UPDATE (lifecycle_revision) ON app.workflows TO {{api_runtime_role}};
