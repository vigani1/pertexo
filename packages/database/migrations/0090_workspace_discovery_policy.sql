-- Permit the API runtime to discover only the current actor's active
-- memberships across workspaces. Ordinary tenant operations remain bound to
-- app.workspace_id through the existing workspace policy.

CREATE POLICY workspace_memberships_actor_discovery
  ON app.workspace_memberships
  FOR SELECT
  TO {{api_runtime_role}}
  USING (
    user_id::text = NULLIF(current_setting('app.actor_id', true), '')
    AND status = 'active'
  );
