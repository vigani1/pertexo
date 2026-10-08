-- ADR 069: one node catalog, served by every API and worker. The database no
-- longer records node releases or gates deployments on them, and every product
-- feature is available without an operator switch.

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND (p.proname LIKE '%node_compatibility%'
         OR p.proname IN ('compatibility_preactivation_cohort_complete',
                          'enforce_phase3_core_executor_non_removal'))
  LOOP
    EXECUTE format('DROP FUNCTION %s CASCADE', v_function);
  END LOOP;
END $$;

DROP TABLE app.node_compatibility_activations CASCADE;
DROP TABLE app.node_compatibility_activation_approvals CASCADE;
DROP TABLE app.node_compatibility_preactivation_checks CASCADE;
DROP TABLE app.node_compatibility_current CASCADE;
DROP TABLE app.node_compatibility_releases CASCADE;

CREATE OR REPLACE FUNCTION app.create_workflow_import_draft(
  p_destination uuid,p_workspace uuid,p_actor uuid,p_graph jsonb,
  p_key_hash char,p_request_hash char,p_command text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_claim record; v_command jsonb; v_graph record; v_node record;
  v_nodes integer:=0; v_edges integer:=0;
  v_origin jsonb; v_expected_refs jsonb; v_connection record; v_workspace_status varchar;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE='42501';
  END IF;
  -- Explicit lock order: workspace, actor, membership, claim, gate, catalog, connections.
  SELECT app.lock_workspace_run_admission(p_workspace) INTO v_workspace_status;
  IF v_workspace_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'workspace is not active' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.users WHERE id=p_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'actor is not active' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=p_workspace AND user_id=p_actor
    AND status='active' AND role IN ('owner','admin','builder') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow author is not active' USING ERRCODE='42501'; END IF;
  SELECT request_hash,status,resource_id INTO v_claim FROM app.idempotency_records
    WHERE workspace_id=p_workspace AND operation='workflow.import'
      AND scope=p_actor::text AND key_hash=p_key_hash FOR UPDATE;
  IF NOT FOUND OR v_claim.status<>'in_progress' OR v_claim.resource_id<>p_destination
    OR v_claim.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'workflow import claim mismatch' USING ERRCODE='42501';
  END IF;
  IF octet_length(p_command)>2097152 OR p_command IS NULL
    OR encode(sha256(convert_to(p_command,'UTF8')),'hex') IS DISTINCT FROM p_request_hash::text THEN
    RAISE EXCEPTION 'workflow import command mismatch' USING ERRCODE='42501';
  END IF;
  v_command:=p_command::jsonb;
  IF jsonb_typeof(v_command) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_command) key)
      NOT IN (ARRAY['bindings','expectedCompatibilityFingerprint','manifest','name']::text[],
        ARRAY['bindings','expectedCompatibilityFingerprint','manifest','name','templateOrigin']::text[])
    OR jsonb_typeof(v_command->'name') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_command->'expectedCompatibilityFingerprint') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_command->'manifest') IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_command->'manifest') key)
      IS DISTINCT FROM ARRAY['connectionSlots','format','formatVersion','graph','requirements']::text[]
    OR jsonb_typeof(v_command->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_command->'manifest'->'connectionSlots') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_command->'manifest'->'requirements') IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_command->'manifest'->'requirements'->'definitions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_command->'manifest'->'requirements'->'selectionFingerprint') IS DISTINCT FROM 'string'
    OR jsonb_array_length(v_command->'manifest'->'requirements'->'definitions')>1000
    OR jsonb_array_length(v_command->'bindings')>1000
    OR jsonb_array_length(v_command->'manifest'->'connectionSlots')>1000 THEN
    RAISE EXCEPTION 'workflow import envelope invalid' USING ERRCODE='42501';
  END IF;
  IF v_command->>'name' IS NULL OR length(v_command->>'name') NOT BETWEEN 1 AND 128
    OR v_command->>'name'<>btrim(v_command->>'name')
    OR v_command->'manifest'->>'format' IS DISTINCT FROM 'pertexo.workflow'
    OR v_command->'manifest'->'formatVersion' IS DISTINCT FROM '1'::jsonb
    OR p_graph->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'workflow import command invalid' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workflow_portability_rollout WHERE singleton AND import_enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow import is disabled' USING ERRCODE='55000'; END IF;
  IF v_command ? 'templateOrigin' THEN
    PERFORM 1 FROM app.curated_template_rollout WHERE singleton AND import_enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'curated template import is disabled' USING ERRCODE='55000'; END IF;
    v_origin:=app.verify_curated_template_origin(v_command->'manifest',v_command->'templateOrigin',p_request_hash::text);
  END IF;
  IF jsonb_typeof(v_command->'manifest'->'graph'->'nodes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_graph->'nodes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'workflow import graph invalid' USING ERRCODE='42501';
  END IF;
  -- Compare graph pairs structurally, never traverse similarly named literal data.
  -- The only permitted transformation is replacing typed connectionRefs with the
  -- exact submitted bindings. The command text is ephemeral, not a receipt body.
  FOR v_graph IN
    WITH RECURSIVE graphs(source,destination,depth) AS (
      SELECT v_command->'manifest'->'graph',p_graph,0
      UNION ALL
      SELECT source_node.value->'structured'->'body',destination_node.value->'structured'->'body',depth+1
      FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(source->'nodes') WITH ORDINALITY source_node
      JOIN LATERAL jsonb_array_elements(destination->'nodes') WITH ORDINALITY destination_node
        ON destination_node.ordinality=source_node.ordinality
      WHERE source_node.value ? 'structured' AND depth<32
    ) SELECT * FROM graphs
  LOOP
    IF jsonb_typeof(v_graph.source) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_graph.destination) IS DISTINCT FROM 'object'
      OR v_graph.source->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR jsonb_typeof(v_graph.source->'nodes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_graph.destination->'nodes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_graph.source->'edges') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_graph.source->'settings') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'workflow import graph invalid' USING ERRCODE='42501';
    END IF;
    v_nodes:=v_nodes+jsonb_array_length(v_graph.source->'nodes');
    v_edges:=v_edges+jsonb_array_length(v_graph.source->'edges');
    IF v_nodes>1000 OR v_edges>4000 THEN
      RAISE EXCEPTION 'workflow import graph limit' USING ERRCODE='42501';
    END IF;
    IF v_graph.source-'nodes' IS DISTINCT FROM v_graph.destination-'nodes'
      OR jsonb_array_length(v_graph.source->'nodes')<>jsonb_array_length(v_graph.destination->'nodes') THEN
      RAISE EXCEPTION 'workflow import graph changed' USING ERRCODE='42501';
    END IF;
    FOR v_node IN SELECT source_node.value source,destination_node.value destination
      FROM jsonb_array_elements(v_graph.source->'nodes') WITH ORDINALITY source_node
      JOIN jsonb_array_elements(v_graph.destination->'nodes') WITH ORDINALITY destination_node
        ON destination_node.ordinality=source_node.ordinality
    LOOP
      IF jsonb_typeof(v_node.source) IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'id') IS DISTINCT FROM 'string'
        OR length(v_node.source->>'id')=0
        OR jsonb_typeof(v_node.source->'definition') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'config') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'inputMappings') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.destination->'connectionRefs') IS DISTINCT FROM 'object'
        OR jsonb_typeof(v_node.source->'position') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'workflow import node invalid' USING ERRCODE='42501';
      END IF;
      IF v_node.source-'connectionRefs'-'structured' IS DISTINCT FROM v_node.destination-'connectionRefs'-'structured'
        OR (v_node.source->'structured')-'body' IS DISTINCT FROM (v_node.destination->'structured')-'body'
        OR v_node.source->'connectionRefs' IS DISTINCT FROM '{}'::jsonb
        OR (v_graph.depth=32 AND v_node.source ? 'structured') THEN
        RAISE EXCEPTION 'workflow import node changed' USING ERRCODE='42501';
      END IF;
      SELECT coalesce(jsonb_object_agg(binding->>'slot',binding->'connectionId'),'{}'::jsonb)
        INTO v_expected_refs FROM jsonb_array_elements(v_command->'bindings') binding
        WHERE binding->>'nodeId'=v_node.source->>'id';
      IF v_node.destination->'connectionRefs' IS DISTINCT FROM v_expected_refs THEN
        RAISE EXCEPTION 'workflow import binding changed' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END LOOP;
  -- Slot declarations must match bindings exactly, including no duplicate/extra entries.
  IF jsonb_array_length(v_command->'bindings')<>jsonb_array_length(v_command->'manifest'->'connectionSlots')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_command->'bindings') b
      WHERE (SELECT count(*) FROM jsonb_array_elements(v_command->'bindings') d
        WHERE d->>'nodeId'=b->>'nodeId' AND d->>'slot'=b->>'slot')<>1
      OR (SELECT count(*) FROM jsonb_array_elements(v_command->'manifest'->'connectionSlots') s
        WHERE s->>'nodeId'=b->>'nodeId' AND s->>'slot'=b->>'slot')<>1) THEN
    RAISE EXCEPTION 'workflow import slots changed' USING ERRCODE='42501';
  END IF;
  FOR v_connection IN SELECT b->>'connectionId' id,s->>'providerKey' provider,s->>'authType' auth
    FROM jsonb_array_elements(v_command->'bindings') b
    JOIN jsonb_array_elements(v_command->'manifest'->'connectionSlots') s
      ON s->>'nodeId'=b->>'nodeId' AND s->>'slot'=b->>'slot'
    ORDER BY b->>'connectionId',b->>'nodeId',b->>'slot'
  LOOP
    PERFORM 1 FROM app.connections WHERE workspace_id=p_workspace AND id=v_connection.id::uuid
      AND provider_key=v_connection.provider AND auth_type=v_connection.auth AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow connection is not available' USING ERRCODE='42501'; END IF;
  END LOOP;
  INSERT INTO app.workflows(id,workspace_id,name,lifecycle_status,activation_status,created_by)
    VALUES(p_destination,p_workspace,v_command->>'name','active','inactive',p_actor);
  INSERT INTO app.workflow_drafts(workflow_id,workspace_id,revision,schema_version,graph_json,updated_by)
    VALUES(p_destination,p_workspace,1,1,p_graph,p_actor);
  IF v_origin IS NOT NULL THEN
    INSERT INTO app.workflow_template_origins(workspace_id,workflow_id,origin)
      VALUES(p_workspace,p_destination,v_origin);
  END IF;
  RETURN p_destination;
END $$;

UPDATE app.curated_template_rollout SET import_enabled = true;
UPDATE app.workflow_input_case_rollout SET enabled = true;
UPDATE app.workflow_organization_rollout SET writes_enabled = true;
UPDATE app.workflow_portability_rollout SET import_enabled = true;
