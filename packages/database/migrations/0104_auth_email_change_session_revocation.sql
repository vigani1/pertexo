-- Verified email changes must revoke browser sessions in the same transaction
-- as the canonical address update. A failing revocation rolls the update back.

CREATE FUNCTION app.revoke_auth_sessions_for_email_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
BEGIN
  DELETE FROM app.auth_sessions WHERE user_id=NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_revoke_auth_sessions_on_email_change
AFTER UPDATE OF email ON app.users
FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION app.revoke_auth_sessions_for_email_change();

ALTER FUNCTION app.revoke_auth_sessions_for_email_change()
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_email_change()
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
