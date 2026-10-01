-- ADR060: a source-scoped command uses the existing finite receipt reaper.
-- Only the additive creator needs elevated INSERT authority. Source selection,
-- admission, receipt, audit and creation are invoked in one authoring transaction.
CREATE FUNCTION app.create_workflow_duplicate_draft(
  p_destination uuid, p_workspace uuid, p_source uuid, p_actor uuid,
  p_name varchar, p_schema integer, p_graph jsonb,
  p_key_hash char, p_request_hash char, p_kind text, p_version uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_source_graph jsonb; v_claim record; v_reference record;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspace_memberships membership
    JOIN app.users actor ON actor.id=membership.user_id
    JOIN app.workspaces workspace ON workspace.id=membership.workspace_id
    WHERE membership.workspace_id=p_workspace AND membership.user_id=p_actor
      AND membership.status='active' AND membership.role IN ('owner','admin','builder')
      AND actor.status='active' AND workspace.status='active'
    FOR SHARE OF membership,actor,workspace;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow author is not active' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=p_workspace AND id=p_source
    AND lifecycle_status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow source is not visible' USING ERRCODE='42501'; END IF;
  SELECT request_hash,status,resource_id INTO v_claim FROM app.idempotency_records
    WHERE workspace_id=p_workspace AND operation='workflow.duplicate'
      AND scope=p_actor::text||':'||p_source::text AND key_hash=p_key_hash FOR UPDATE;
  IF NOT FOUND OR v_claim.status<>'in_progress' OR v_claim.resource_id<>p_destination
    OR v_claim.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'workflow duplication claim mismatch' USING ERRCODE='42501';
  END IF;
  IF p_kind='draft' AND p_version IS NULL THEN
    SELECT graph_json INTO v_source_graph FROM app.workflow_drafts
      WHERE workspace_id=p_workspace AND workflow_id=p_source FOR UPDATE;
  ELSIF p_kind='version' AND p_version IS NOT NULL THEN
    SELECT graph_json INTO v_source_graph FROM app.workflow_versions
      WHERE workspace_id=p_workspace AND workflow_id=p_source AND id=p_version FOR SHARE;
  ELSE RAISE EXCEPTION 'workflow source selector invalid' USING ERRCODE='22023';
  END IF;
  IF v_source_graph IS NULL OR v_source_graph IS DISTINCT FROM p_graph OR p_schema<>1
    OR p_destination=p_source OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'workflow source content mismatch' USING ERRCODE='42501';
  END IF;
  -- Traverse only structured graph bodies, never similarly named user literals.
  FOR v_reference IN
    WITH RECURSIVE graphs(graph) AS (
      SELECT v_source_graph UNION ALL
      SELECT node.value->'structured'->'body' FROM graphs
        CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
        WHERE node.value->'structured'->>'kind'='for_each'
    ) SELECT DISTINCT reference.value::uuid AS id FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
      CROSS JOIN LATERAL jsonb_each_text(node.value->'connectionRefs') reference
      ORDER BY id
  LOOP
    PERFORM 1 FROM app.connections WHERE workspace_id=p_workspace AND id=v_reference.id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow connection is not visible' USING ERRCODE='42501'; END IF;
  END LOOP;
  INSERT INTO app.workflows(id,workspace_id,name,lifecycle_status,activation_status,created_by)
    VALUES(p_destination,p_workspace,p_name,'active','inactive',p_actor);
  INSERT INTO app.workflow_drafts(workflow_id,workspace_id,revision,schema_version,graph_json,updated_by)
    VALUES(p_destination,p_workspace,1,p_schema,v_source_graph,p_actor);
  RETURN p_destination;
END $$;
ALTER FUNCTION app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,varchar,integer,jsonb,char,char,text,uuid)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,varchar,integer,jsonb,char,char,text,uuid)
  FROM PUBLIC,{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,varchar,integer,jsonb,char,char,text,uuid)
  TO {{api_runtime_role}};
