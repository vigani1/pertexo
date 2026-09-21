-- Support the bounded recently-updated workflow list without scanning or
-- sorting the full workspace collection.
CREATE INDEX workflows_workspace_updated_idx
  ON app.workflows (workspace_id, updated_at DESC, id DESC);
