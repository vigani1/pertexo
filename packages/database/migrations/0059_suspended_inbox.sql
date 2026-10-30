-- A suspended workspace reads but does not change (ADR 013/027). Its inbox shows
-- again; writes stay fenced by the active-only authority lock in TypeScript.
CREATE OR REPLACE FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO pg_catalog,app AS $$
 SELECT p_workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND p_user_id::text=NULLIF(current_setting('app.actor_id',true),'') AND EXISTS(
 SELECT 1 FROM app.workspace_memberships m JOIN app.workspaces w ON w.id=m.workspace_id JOIN app.users u ON u.id=m.user_id WHERE m.workspace_id=p_workspace_id AND m.user_id=p_user_id AND m.status='active' AND w.status IN ('active','suspended') AND u.status='active');
$$;
