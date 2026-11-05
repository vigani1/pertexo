CREATE FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, app, pg_temp SET row_security TO on AS $$
DECLARE v_members integer; v_deleted integer;
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')
     OR p_table IS NULL OR p_table NOT IN ('app.notice_preferences'::regclass,'app.notice_subscriptions'::regclass,'app.workspace_inbox_reads'::regclass)
  THEN RAISE EXCEPTION 'removed membership storage scope required' USING ERRCODE='42501'; END IF;
  IF p_user_ids IS NULL OR cardinality(p_user_ids)=0 THEN RETURN 0; END IF;
  -- Fence reactivation until the caller's transaction finishes deleting private rows.
  PERFORM user_id FROM app.workspace_memberships
    WHERE workspace_id=p_workspace_id AND user_id=ANY(p_user_ids) AND status='removed'
    ORDER BY user_id FOR SHARE;
  GET DIAGNOSTICS v_members = ROW_COUNT;
  IF v_members<>cardinality(p_user_ids) THEN
    RAISE EXCEPTION 'removed membership required' USING ERRCODE='42501';
  END IF;
  EXECUTE format('DELETE FROM %s WHERE workspace_id=$1 AND user_id=ANY($2)',p_table)
    USING p_workspace_id,p_user_ids;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION app.delete_removed_member_private_rows(uuid,uuid[],regclass) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_removed_member_private_rows(uuid,uuid[],regclass) TO {{app_role}};
COMMENT ON FUNCTION app.delete_removed_member_private_rows(uuid,uuid[],regclass) IS
  'Storage capability: delete only the named private table rows for scoped, locked removed memberships. Core owns cleanup selection; personal-row read policies are unchanged.';
--> statement-breakpoint
DROP FUNCTION app.clear_removed_member_notices(uuid,uuid);
