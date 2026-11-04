-- Only the matching capability can resolve this scope. Core owns availability.
DROP FUNCTION app.lookup_public_form(uuid,character);
--> statement-breakpoint
CREATE FUNCTION app.lookup_public_form(p_public_id uuid,p_digest char(64))
RETURNS TABLE(workspace_id uuid,workflow_id uuid,node_id varchar,access varchar,workspace_status varchar)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on
AS $function$
  SELECT form.workspace_id,form.workflow_id,form.node_id,form.access,workspace.status
  FROM app.workflow_forms form JOIN app.workspaces workspace ON workspace.id=form.workspace_id
  WHERE form.public_id=p_public_id AND form.capability_hash=p_digest;
$function$;
REVOKE ALL ON FUNCTION app.lookup_public_form(uuid,character) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lookup_public_form(uuid,character) TO {{app_role}};
