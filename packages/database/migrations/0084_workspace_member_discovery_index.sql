-- Match the membership discovery keyset and exclude removed memberships.
-- The migration runner's lock/statement deadlines bound this atomic index build.
CREATE INDEX workspace_memberships_workspace_created_idx
  ON app.workspace_memberships (workspace_id, created_at, user_id)
  WHERE status IN ('active', 'suspended');
