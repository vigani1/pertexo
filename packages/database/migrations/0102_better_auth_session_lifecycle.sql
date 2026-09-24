-- Keep Better Auth's sole browser-session authority aligned with Pertexo user
-- and workspace lifecycle changes. Trigger functions run with owner rights so
-- lifecycle roles never receive direct access to authentication material.

CREATE FUNCTION app.revoke_auth_sessions_for_inactive_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
BEGIN
  IF OLD.status='active' AND NEW.status<>'active' THEN
    DELETE FROM app.auth_sessions WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_revoke_auth_sessions_on_deactivation
AFTER UPDATE OF status ON app.users
FOR EACH ROW
EXECUTE FUNCTION app.revoke_auth_sessions_for_inactive_user();

CREATE FUNCTION app.revoke_auth_sessions_for_workspace_unavailability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
DECLARE v_prior_workspace text;
BEGIN
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  DELETE FROM app.auth_sessions
   WHERE user_id IN (
     SELECT membership.user_id
       FROM app.workspace_memberships membership
      WHERE membership.workspace_id=NEW.id
        AND membership.status<>'removed'
   );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END;
$$;

CREATE TRIGGER workspaces_revoke_auth_sessions_on_unavailability
AFTER UPDATE OF status ON app.workspaces
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  AND NEW.status IN ('suspended','pending_deletion','purging','deleted')
)
EXECUTE FUNCTION app.revoke_auth_sessions_for_workspace_unavailability();

CREATE FUNCTION app.prune_expired_auth_sessions(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10000 THEN
    RAISE EXCEPTION 'invalid auth session prune limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT session.id
      FROM app.auth_sessions session
     WHERE session.expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY session.expires_at,session.id
     LIMIT p_limit
     FOR UPDATE OF session SKIP LOCKED
  )
  DELETE FROM app.auth_sessions session
  USING candidates
  WHERE session.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_inactive_user(),
  app.revoke_auth_sessions_for_workspace_unavailability(),
  app.prune_expired_auth_sessions(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.prune_expired_auth_sessions(integer)
  TO {{maintenance_role}};
