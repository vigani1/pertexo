-- Repair the published discovery policy without changing migration 0090.
-- Actor-wide membership visibility is enabled only by the dedicated
-- actor-discovery transaction and never by an ordinary workspace transaction.

DROP POLICY workspace_memberships_actor_discovery
  ON app.workspace_memberships;

CREATE POLICY workspace_memberships_actor_discovery
  ON app.workspace_memberships
  FOR SELECT
  TO {{api_runtime_role}}
  USING (
    current_setting('app.discovery_scope', true) = 'workspace_memberships'
    AND NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    AND user_id::text = NULLIF(current_setting('app.actor_id', true), '')
    AND status = 'active'
  );
