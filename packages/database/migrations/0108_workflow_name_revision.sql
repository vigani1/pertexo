-- ADR 041: workflow rename uses its own name revision, independent of the
-- ADR 034 lifecycle revision and the ADR 011 draft revision. Every existing
-- workflow has never been renamed through the command, so it starts at one.

ALTER TABLE app.workflows
  ADD COLUMN name_revision integer NOT NULL DEFAULT 1;

ALTER TABLE app.workflows
  ADD CONSTRAINT workflows_name_revision_positive
  CHECK (name_revision > 0);

-- The API runtime already updates the display name. The rename command may
-- advance only this revision beside it; identity, creation metadata and the
-- published pointer stay outside the rename seam.
GRANT UPDATE (name_revision) ON app.workflows TO {{api_runtime_role}};
