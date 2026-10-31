-- Invitations are workspace-scoped, but a closed install's sign-up asks about one
-- address before any workspace is known. Answers yes or no, and nothing else.
CREATE FUNCTION app.has_pending_invitation(p_normalized_email varchar)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog,app SET row_security TO on AS $$
 SELECT EXISTS (
  SELECT 1 FROM app.workspace_invitations invitation
  WHERE invitation.normalized_email=p_normalized_email
    AND invitation.status='pending'
    AND invitation.expires_at>clock_timestamp()
 )
$$;
REVOKE ALL ON FUNCTION app.has_pending_invitation(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_pending_invitation(varchar) TO {{app_role}};
