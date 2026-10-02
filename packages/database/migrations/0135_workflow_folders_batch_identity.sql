-- ADR064 accepted F07 follow-on. Additive; never rewrite qualified 0134.
-- The existing independent organization writer remains OFF unless explicitly
-- enabled by deployment after complete qualification.
UPDATE app.workflow_organization_rollout SET writes_enabled=false WHERE singleton;
CREATE TABLE app.workflow_folders (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL,
  parent_id uuid,
  name text COLLATE "C" NOT NULL CHECK(name=btrim(name,' ')
    AND octet_length(name) BETWEEN 1 AND 128 AND name COLLATE "C" !~ '[[:cntrl:]]'),
  name_key text COLLATE "C" NOT NULL CHECK(name_key=translate(name,
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(workspace_id,id),
  UNIQUE NULLS NOT DISTINCT(workspace_id,parent_id,name_key),
  FOREIGN KEY(workspace_id,parent_id) REFERENCES app.workflow_folders(workspace_id,id),
  CHECK(parent_id IS DISTINCT FROM id)
);
CREATE INDEX workflow_folders_parent_idx ON app.workflow_folders(workspace_id,parent_id,id);
ALTER TABLE app.workflow_folders OWNER TO {{owner_role}};
ALTER TABLE app.workflow_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_folders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.workflow_folders FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},
  {{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
CREATE POLICY workflow_folders_owner ON app.workflow_folders FOR ALL TO {{owner_role}}
  USING(true) WITH CHECK(true);
CREATE POLICY workflow_folders_reader ON app.workflow_folders FOR SELECT TO {{api_runtime_role}} USING(
  workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
  AND EXISTS(SELECT 1 FROM app.workspaces w JOIN app.workspace_memberships m ON m.workspace_id=w.id
    JOIN app.users u ON u.id=m.user_id WHERE w.id=workflow_folders.workspace_id AND w.status='active'
    AND m.user_id::text=nullif(current_setting('app.actor_id',true),'') AND m.status='active' AND u.status='active'));
GRANT SELECT ON app.workflow_folders TO {{api_runtime_role}};
ALTER TABLE app.workflow_organization_state ADD COLUMN folder_id uuid;
ALTER TABLE app.workflow_organization_state ADD CONSTRAINT workflow_organization_state_folder_fk
  FOREIGN KEY(workspace_id,folder_id) REFERENCES app.workflow_folders(workspace_id,id);
CREATE INDEX workflow_organization_state_folder_idx
  ON app.workflow_organization_state(workspace_id,folder_id,workflow_id);
ALTER TABLE app.workflow_organization_receipts DROP CONSTRAINT workflow_organization_receipts_operation_check;
ALTER TABLE app.workflow_organization_receipts ADD CONSTRAINT workflow_organization_receipts_operation_check
  CHECK(operation IN ('tag.create','tag.rename','tag.delete','tags.replace','tag.detach',
    'folder.create','folder.rename','folder.move','folder.delete','folder.place',
    'organization.batch.identity','organization.batch.item'));
-- Store the top-level transaction, not tuple xmin (which can be a subxid).
-- This is internal admission proof, not a result/history or serving-role read.
ALTER TABLE app.workflow_organization_receipts ADD COLUMN admission_xid xid8;
ALTER TABLE app.workflow_organization_receipts ADD CONSTRAINT workflow_organization_receipts_admission_xid_check
  CHECK((operation='organization.batch.identity' AND (result IS NULL OR admission_xid IS NOT NULL))
    OR (operation<>'organization.batch.identity' AND admission_xid IS NULL));

-- Private validation owners are not granted to serving roles. UUIDs/revisions
-- are normalized before receipt hashing, and no caller-selected SQL is accepted.
CREATE FUNCTION app.workflow_organization_uuid(p_value jsonb,p_nullable boolean) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF p_nullable AND p_value='null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR octet_length(p_value#>>'{}')<>36
    OR (p_value#>>'{}') COLLATE "C" !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
    RAISE EXCEPTION 'organization identifier invalid' USING ERRCODE='22023'; END IF;
  RETURN (p_value#>>'{}')::uuid;
END $$;
CREATE FUNCTION app.workflow_organization_revision(p_value jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
    OR (p_value#>>'{}')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR trunc((p_value#>>'{}')::numeric)<>(p_value#>>'{}')::numeric THEN
    RAISE EXCEPTION 'organization revision invalid' USING ERRCODE='22023'; END IF;
  RETURN (p_value#>>'{}')::bigint;
END $$;
CREATE FUNCTION app.workflow_folder_command_body(p_operation text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_keys text[]; v_name text; v_parent uuid; v_revision bigint;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('folder.create','folder.rename','folder.move','folder.delete','folder.place')
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>2048 THEN
    RAISE EXCEPTION 'folder command invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO v_keys FROM jsonb_object_keys(p_body) key;
  IF v_keys IS DISTINCT FROM (CASE p_operation
    WHEN 'folder.create' THEN ARRAY['name','parentId']::text[]
    WHEN 'folder.rename' THEN ARRAY['expectedFolderRevision','name']::text[]
    WHEN 'folder.move' THEN ARRAY['expectedFolderRevision','parentId']::text[]
    WHEN 'folder.delete' THEN ARRAY['expectedFolderRevision']::text[]
    ELSE ARRAY['expectedOrganizationRevision','folderId']::text[] END) THEN
    RAISE EXCEPTION 'folder command invalid' USING ERRCODE='22023'; END IF;
  IF p_operation IN ('folder.create','folder.rename') THEN
    IF jsonb_typeof(p_body->'name') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'folder name invalid' USING ERRCODE='22023'; END IF;
    v_name:=btrim(p_body->>'name',' ');
    IF octet_length(v_name) NOT BETWEEN 1 AND 128 OR v_name COLLATE "C" ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'folder name invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_operation IN ('folder.create','folder.move') THEN
    v_parent:=app.workflow_organization_uuid(p_body->'parentId',true);
  ELSIF p_operation='folder.place' THEN
    v_parent:=app.workflow_organization_uuid(p_body->'folderId',true);
  END IF;
  IF p_operation<>'folder.create' THEN
    v_revision:=app.workflow_organization_revision(p_body->(CASE WHEN p_operation='folder.place'
      THEN 'expectedOrganizationRevision' ELSE 'expectedFolderRevision' END));
  END IF;
  RETURN CASE p_operation
    WHEN 'folder.create' THEN jsonb_build_object('name',v_name,'parentId',v_parent)
    WHEN 'folder.rename' THEN jsonb_build_object('name',v_name,'expectedFolderRevision',v_revision)
    WHEN 'folder.move' THEN jsonb_build_object('parentId',v_parent,'expectedFolderRevision',v_revision)
    WHEN 'folder.delete' THEN jsonb_build_object('expectedFolderRevision',v_revision)
    ELSE jsonb_build_object('folderId',v_parent,'expectedOrganizationRevision',v_revision) END;
END $$;

-- At most four levels. A defensive fifth level/missing root never becomes a
-- guessed path. Caller holds organization coordination for hierarchy mutation.
CREATE FUNCTION app.workflow_folder_depth(p_workspace uuid,p_folder uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_depth integer;
BEGIN
  IF p_folder IS NULL THEN RETURN 0; END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,1 depth,ARRAY[id] path FROM app.workflow_folders WHERE workspace_id=p_workspace AND id=p_folder
    UNION ALL SELECT f.id,f.parent_id,a.depth+1,a.path||f.id
      FROM ancestors a JOIN app.workflow_folders f ON f.workspace_id=p_workspace AND f.id=a.parent_id
      WHERE a.depth<5 AND NOT f.id=ANY(a.path)
  ) SELECT depth INTO v_depth FROM ancestors WHERE parent_id IS NULL;
  IF v_depth IS NULL OR v_depth>4 THEN
    RAISE EXCEPTION 'folder hierarchy conflict' USING ERRCODE='P7014'; END IF;
  RETURN v_depth;
END $$;
CREATE FUNCTION app.execute_workflow_folder_command(p_operation text,p_folder uuid,p_key_hash text,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_request jsonb; v_replay jsonb; v_target uuid; v_parent uuid;
  v_name text; v_name_key text; v_folder app.workflow_folders%ROWTYPE; v_depth integer;
  v_height integer; v_cycle boolean; v_result jsonb;
BEGIN
  IF (p_operation='folder.create' AND p_folder IS NOT NULL)
    OR (p_operation<>'folder.create' AND p_folder IS NULL) OR p_operation='folder.place' THEN
    RAISE EXCEPTION 'folder command invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_folder_command_body(p_operation,p_body);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin']);
  v_target:=coalesce(p_folder,'00000000-0000-0000-0000-000000000000'::uuid);
  v_replay:=app.claim_workflow_organization_command(p_operation,v_target,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay||jsonb_build_object('replayed',true); END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(true);
  -- Hierarchy is bounded to 256; stable UUID order includes ancestors/descendants.
  PERFORM 1 FROM app.workflow_folders WHERE workspace_id=v_workspace ORDER BY id FOR UPDATE;
  IF p_operation IN ('folder.create','folder.move') THEN
    v_parent:=(v_request->>'parentId')::uuid;
    IF v_parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=v_parent) THEN
      RAISE EXCEPTION 'folder is not visible' USING ERRCODE='42501'; END IF;
  END IF;
  IF p_operation<>'folder.create' THEN
    SELECT * INTO v_folder FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=p_folder;
    IF NOT FOUND THEN RAISE EXCEPTION 'folder is not visible' USING ERRCODE='42501'; END IF;
    IF v_folder.revision<>(v_request->>'expectedFolderRevision')::bigint OR v_folder.revision=9007199254740991 THEN
      RAISE EXCEPTION 'folder revision conflict' USING ERRCODE='P7013'; END IF;
    IF p_operation NOT IN ('folder.move','folder.delete') THEN v_parent:=v_folder.parent_id; END IF;
  END IF;
  IF p_operation IN ('folder.create','folder.rename') THEN v_name:=v_request->>'name';
  ELSE v_name:=v_folder.name; END IF;
  v_name_key:=translate(v_name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
  IF p_operation<>'folder.delete' AND EXISTS(SELECT 1 FROM app.workflow_folders
    WHERE workspace_id=v_workspace AND parent_id IS NOT DISTINCT FROM v_parent
      AND name_key=v_name_key AND id IS DISTINCT FROM p_folder) THEN
    RAISE EXCEPTION 'folder name conflict' USING ERRCODE='P7011'; END IF;
  IF p_operation='folder.create' THEN
    IF (SELECT count(*) FROM (SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace LIMIT 257) bounded)>=256 THEN
      RAISE EXCEPTION 'workspace folder limit' USING ERRCODE='P7012'; END IF;
    v_depth:=app.workflow_folder_depth(v_workspace,v_parent)+1;
    IF v_depth>4 THEN RAISE EXCEPTION 'folder hierarchy conflict' USING ERRCODE='P7014'; END IF;
    INSERT INTO app.workflow_folders(workspace_id,id,parent_id,name,name_key)
      VALUES(v_workspace,uuidv7(),v_parent,v_name,v_name_key) RETURNING * INTO v_folder;
  ELSIF p_operation='folder.delete' THEN
    IF EXISTS(SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace AND parent_id=p_folder)
      OR EXISTS(SELECT 1 FROM app.workflow_organization_state WHERE workspace_id=v_workspace AND folder_id=p_folder) THEN
      RAISE EXCEPTION 'folder is not empty' USING ERRCODE='P7015'; END IF;
    DELETE FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=p_folder;
    v_result:=jsonb_build_object('folderId',p_folder,'deleted',true);
  ELSE
    IF p_operation='folder.move' THEN
      WITH RECURSIVE descendants AS (
        SELECT id,1 height FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=p_folder
        UNION ALL SELECT f.id,d.height+1 FROM descendants d JOIN app.workflow_folders f
          ON f.workspace_id=v_workspace AND f.parent_id=d.id WHERE d.height<5
      ) SELECT max(height),bool_or(id=v_parent) INTO v_height,v_cycle FROM descendants;
      v_depth:=app.workflow_folder_depth(v_workspace,v_parent)+1;
      IF v_cycle OR v_height+v_depth-1>4 THEN
        RAISE EXCEPTION 'folder hierarchy conflict' USING ERRCODE='P7014'; END IF;
    END IF;
    UPDATE app.workflow_folders SET name=v_name,name_key=v_name_key,parent_id=v_parent,revision=revision+1
      WHERE workspace_id=v_workspace AND id=p_folder RETURNING * INTO v_folder;
  END IF;
  IF p_operation<>'folder.delete' THEN
    v_result:=jsonb_build_object('folder',jsonb_build_object('id',v_folder.id,'name',v_folder.name,
      'parentId',v_folder.parent_id,'revision',v_folder.revision,'depth',app.workflow_folder_depth(v_workspace,v_folder.id)));
  END IF;
  PERFORM app.record_workflow_organization_audit('workflow.'||p_operation,v_folder.id,'{}'::jsonb);
  PERFORM app.complete_workflow_organization_command(p_operation,v_target,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

-- Full immutable parent is canonicalized in SQL, never accepted as a supplied
-- hash/proof. One parent namespace covers every batch purpose and item ordering.
CREATE FUNCTION app.workflow_organization_batch_body(p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_operation text; v_keys text[]; v_items jsonb:='[]'::jsonb; v_item jsonb;
  v_ids uuid[]:=ARRAY[]::uuid[]; v_id uuid; v_revision bigint; v_target jsonb; v_tags uuid[];
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>8192 THEN
    RAISE EXCEPTION 'organization batch invalid' USING ERRCODE='22023'; END IF;
  v_operation:=p_body->>'operation';
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO v_keys FROM jsonb_object_keys(p_body) key;
  IF v_operation IS NULL OR v_operation NOT IN ('move','replace_tags','tag_cleanup') OR v_keys IS DISTINCT FROM
    (CASE v_operation WHEN 'move' THEN ARRAY['folderId','items','operation']::text[]
      WHEN 'replace_tags' THEN ARRAY['items','operation','tagIds']::text[]
      ELSE ARRAY['items','operation','tagId']::text[] END) THEN
    RAISE EXCEPTION 'organization batch invalid' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_body->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'organization batch selection invalid' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_body->'items') NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'organization batch selection invalid' USING ERRCODE='22023'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_body->'items') LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'organization batch item invalid' USING ERRCODE='22023'; END IF;
    IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(v_item) key)
      IS DISTINCT FROM ARRAY['expectedOrganizationRevision','workflowId']::text[] THEN
      RAISE EXCEPTION 'organization batch item invalid' USING ERRCODE='22023'; END IF;
    v_id:=app.workflow_organization_uuid(v_item->'workflowId',false);
    v_revision:=app.workflow_organization_revision(v_item->'expectedOrganizationRevision');
    IF v_id=ANY(v_ids) THEN RAISE EXCEPTION 'organization batch selection invalid' USING ERRCODE='22023'; END IF;
    v_ids:=v_ids||v_id;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('workflowId',v_id,'expectedOrganizationRevision',v_revision));
  END LOOP;
  IF v_operation='move' THEN
    v_target:=to_jsonb(app.workflow_organization_uuid(p_body->'folderId',true));
  ELSIF v_operation='tag_cleanup' THEN
    v_target:=to_jsonb(app.workflow_organization_uuid(p_body->'tagId',false));
  ELSE
    IF jsonb_typeof(p_body->'tagIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'organization batch target invalid' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_body->'tagIds')>16 THEN
      RAISE EXCEPTION 'organization batch target invalid' USING ERRCODE='22023'; END IF;
    SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_tags FROM (
      SELECT app.workflow_organization_uuid(value,false) id FROM jsonb_array_elements(p_body->'tagIds')) ids;
    IF cardinality(v_tags)<>(SELECT count(DISTINCT id) FROM unnest(v_tags) id) THEN
      RAISE EXCEPTION 'organization batch target invalid' USING ERRCODE='22023'; END IF;
    v_target:=to_jsonb(v_tags);
  END IF;
  RETURN jsonb_build_object('v',1,'purpose','organization.batch','operation',v_operation,
    'target',coalesce(v_target,'null'::jsonb),'items',v_items);
END $$;
CREATE FUNCTION app.admit_workflow_organization_batch(p_key_hash text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_request jsonb; v_replay jsonb;
BEGIN
  v_request:=app.workflow_organization_batch_body(p_body);
  v_workspace:=app.lock_workflow_organization_authority(CASE WHEN v_request->>'operation'='tag_cleanup'
    THEN ARRAY['owner','admin'] ELSE ARRAY['owner','admin','builder'] END);
  v_replay:=app.claim_workflow_organization_command('organization.batch.identity',v_workspace,p_key_hash,v_request);
  IF EXISTS(SELECT 1 FROM app.workflow_organization_receipts WHERE workspace_id=v_workspace
    AND actor_id::text=current_setting('app.actor_id') AND operation='organization.batch.identity'
    AND target_id=v_workspace AND key_hash=p_key_hash AND expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'organization batch recovery expired' USING ERRCODE='P7002'; END IF;
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  UPDATE app.workflow_organization_receipts SET admission_xid=pg_current_xact_id()
    WHERE workspace_id=v_workspace AND actor_id::text=current_setting('app.actor_id')
      AND operation='organization.batch.identity' AND target_id=v_workspace AND key_hash=p_key_hash AND result IS NULL;
  PERFORM app.complete_workflow_organization_command('organization.batch.identity',v_workspace,p_key_hash,'{"admitted":true}'::jsonb);
  RETURN '{"admitted":true}'::jsonb;
END $$;

-- Private mutation shared by placement and guarded batch items. The public
-- wrappers acquire authority + receipt before this coordinator/folder/tag/WF
-- lock sequence. Existing 0134 helper bodies and single-command ABIs stay intact.
CREATE FUNCTION app.apply_workflow_organization_item(p_operation text,p_workflow uuid,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_folder uuid; v_previous_folder uuid; v_tags uuid[];
  v_lifecycle text; v_role text; v_revision bigint; v_expected bigint; v_id uuid; v_result jsonb;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_expected:=(p_body->>'expectedOrganizationRevision')::bigint;
  PERFORM app.lock_workflow_organization_coordination(true);
  IF p_operation='move' THEN
    v_folder:=(p_body->>'folderId')::uuid;
    SELECT folder_id INTO v_previous_folder FROM app.workflow_organization_state
      WHERE workspace_id=v_workspace AND workflow_id=p_workflow;
    PERFORM 1 FROM app.workflow_folders WHERE workspace_id=v_workspace
      AND id IN (v_folder,v_previous_folder) ORDER BY id FOR UPDATE;
    IF v_folder IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.workflow_folders WHERE workspace_id=v_workspace AND id=v_folder) THEN
      RAISE EXCEPTION 'folder is not visible' USING ERRCODE='P7016'; END IF;
  ELSE
    SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_tags FROM (
      SELECT (value#>>'{}')::uuid id FROM jsonb_array_elements(CASE p_operation
        WHEN 'replace_tags' THEN p_body->'tagIds' ELSE jsonb_build_array(p_body->'tagId') END)) ids;
    PERFORM 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_tags) ORDER BY id FOR UPDATE;
    IF (SELECT count(*) FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_tags))<>cardinality(v_tags) THEN
      RAISE EXCEPTION 'organization target is not visible' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT lifecycle_status INTO v_lifecycle FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  SELECT role INTO v_role FROM app.workspace_memberships WHERE workspace_id=v_workspace
    AND user_id::text=current_setting('app.actor_id') AND status='active';
  IF v_lifecycle<>'active' AND (p_operation='replace_tags' OR (p_operation='move' AND v_role NOT IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
  SELECT revision INTO v_revision FROM app.workflow_organization_state WHERE workspace_id=v_workspace AND workflow_id=p_workflow;
  v_revision:=coalesce(v_revision,1);
  IF v_revision<>v_expected OR v_revision=9007199254740991 THEN
    RAISE EXCEPTION 'organization revision conflict' USING ERRCODE='P7008'; END IF;
  IF p_operation='move' THEN
    INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision,folder_id)
      VALUES(v_workspace,p_workflow,v_revision+1,v_folder) ON CONFLICT(workspace_id,workflow_id)
      DO UPDATE SET revision=EXCLUDED.revision,folder_id=EXCLUDED.folder_id;
  ELSE
    IF p_operation='replace_tags' THEN
      DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND workflow_id=p_workflow;
      FOREACH v_id IN ARRAY v_tags LOOP
        INSERT INTO app.workflow_tag_assignments(workspace_id,workflow_id,tag_id) VALUES(v_workspace,p_workflow,v_id);
      END LOOP;
    ELSE
      DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND workflow_id=p_workflow AND tag_id=v_tags[1];
    END IF;
    INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision)
      VALUES(v_workspace,p_workflow,v_revision+1) ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET revision=EXCLUDED.revision;
  END IF;
  v_result:=jsonb_build_object('workflowId',p_workflow,'organizationRevision',v_revision+1);
  IF p_operation='move' THEN v_result:=v_result||jsonb_build_object('folderId',v_folder); END IF;
  PERFORM app.record_workflow_organization_audit('workflow.organization.'||p_operation,p_workflow,
    jsonb_build_object('organizationRevision',v_revision+1));
  RETURN v_result;
END $$;
CREATE FUNCTION app.execute_workflow_folder_placement(p_workflow uuid,p_key_hash text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_request jsonb; v_replay jsonb; v_result jsonb; v_lifecycle text;
BEGIN
  IF p_workflow IS NULL THEN RAISE EXCEPTION 'workflow target invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_folder_command_body('folder.place',p_body);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin','builder']);
  v_replay:=app.claim_workflow_organization_command('folder.place',p_workflow,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN
    SELECT lifecycle_status INTO v_lifecycle FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    IF v_lifecycle<>'active' AND NOT EXISTS(SELECT 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace
      AND user_id::text=current_setting('app.actor_id') AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  v_result:=app.apply_workflow_organization_item('move',p_workflow,v_request);
  PERFORM app.complete_workflow_organization_command('folder.place',p_workflow,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION app.execute_workflow_organization_batch_item(
  p_parent_key_hash text,p_body jsonb,p_workflow uuid,p_item_key_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_request jsonb; v_parent app.workflow_organization_receipts%ROWTYPE;
  v_hash text; v_item jsonb; v_body jsonb; v_replay jsonb; v_result jsonb; v_operation text; v_lifecycle text;
BEGIN
  IF p_workflow IS NULL THEN RAISE EXCEPTION 'batch item invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_organization_batch_body(p_body); v_operation:=v_request->>'operation';
  v_workspace:=app.lock_workflow_organization_authority(CASE WHEN v_operation='tag_cleanup'
    THEN ARRAY['owner','admin'] ELSE ARRAY['owner','admin','builder'] END);
  v_hash:=encode(sha256(convert_to(v_request::text,'UTF8')),'hex');
  SELECT * INTO v_parent FROM app.workflow_organization_receipts r
    WHERE r.workspace_id=v_workspace AND r.actor_id::text=current_setting('app.actor_id')
      AND r.operation='organization.batch.identity' AND r.target_id=v_workspace AND r.key_hash=p_parent_key_hash FOR SHARE;
  -- Own-transaction creation is not committed admission. Concurrent uncommitted
  -- admissions are invisible under READ COMMITTED; the adapter must retry only
  -- the entire frozen request after committing its separate admission TX.
  IF NOT FOUND OR v_parent.result IS DISTINCT FROM '{"admitted":true}'::jsonb
    OR v_parent.request_hash<>v_hash OR v_parent.expires_at<=clock_timestamp()
    OR v_parent.admission_xid IS NULL OR v_parent.admission_xid=pg_current_xact_id()
    OR p_item_key_hash IS DISTINCT FROM encode(sha256(convert_to(
      '{"v":1,"p":"organization.batch.item","k":"'||p_parent_key_hash||'","id":"'||p_workflow::text||'"}','UTF8')),'hex') THEN
    RAISE EXCEPTION 'organization batch admission invalid' USING ERRCODE='P7002'; END IF;
  SELECT value INTO v_item FROM jsonb_array_elements(v_request->'items') WHERE value->>'workflowId'=p_workflow::text;
  IF v_item IS NULL THEN RAISE EXCEPTION 'organization batch item invalid' USING ERRCODE='22023'; END IF;
  v_body:=jsonb_build_object('expectedOrganizationRevision',v_item->'expectedOrganizationRevision')||CASE v_operation
    WHEN 'move' THEN jsonb_build_object('folderId',v_request->'target')
    WHEN 'replace_tags' THEN jsonb_build_object('tagIds',v_request->'target')
    ELSE jsonb_build_object('tagId',v_request->'target') END;
  v_replay:=app.claim_workflow_organization_command('organization.batch.item',p_workflow,p_item_key_hash,
    jsonb_build_object('parentHash',v_hash,'purpose',v_operation,'body',v_body));
  IF v_replay IS NOT NULL THEN
    SELECT lifecycle_status INTO v_lifecycle FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    IF v_operation='move' AND v_lifecycle<>'active' AND NOT EXISTS(SELECT 1 FROM app.workspace_memberships
      WHERE workspace_id=v_workspace AND user_id::text=current_setting('app.actor_id') AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  v_result:=app.apply_workflow_organization_item(v_operation,p_workflow,v_body);
  PERFORM app.complete_workflow_organization_command('organization.batch.item',p_workflow,p_item_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;

-- Confined ACL inventory: no direct writes and no public internal validators.
DO $$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'app.workflow_organization_uuid(jsonb,boolean)','app.workflow_organization_revision(jsonb)',
    'app.workflow_folder_command_body(text,jsonb)','app.workflow_folder_depth(uuid,uuid)',
    'app.execute_workflow_folder_command(text,uuid,text,jsonb)','app.workflow_organization_batch_body(jsonb)',
    'app.admit_workflow_organization_batch(text,jsonb)','app.apply_workflow_organization_item(text,uuid,jsonb)',
    'app.execute_workflow_folder_placement(uuid,text,jsonb)','app.execute_workflow_organization_batch_item(text,jsonb,uuid,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %s',signature,'{{owner_role}}');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%s,%s,%s,%s,%s,%s',signature,
      '{{api_runtime_role}}','{{worker_runtime_role}}','{{dispatcher_role}}','{{maintenance_role}}','{{operator_role}}','{{lifecycle_command_role}}');
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.execute_workflow_folder_command(text,uuid,text,jsonb),
  app.admit_workflow_organization_batch(text,jsonb),app.execute_workflow_folder_placement(uuid,text,jsonb),
  app.execute_workflow_organization_batch_item(text,jsonb,uuid,text) TO {{api_runtime_role}};

-- Preserve the complete 0134 purge body under its confined alias. Placement rows
-- are drained before folders; folders are deleted leaf-first, never cascaded or
-- unfiled. Exactly one relation and at most p_page_size rows per call.
ALTER FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)
  RENAME TO execute_workspace_tenant_rows_page_before_folders;
REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page_before_folders(uuid,uuid,bigint,integer,bigint,char)
  FROM {{maintenance_role}},{{operator_role}};
CREATE FUNCTION app.execute_workspace_tenant_rows_page(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_size integer,
  p_projected_sequence bigint,p_projected_hash char(64)
) RETURNS TABLE(surface varchar,affected_count integer,completed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE; v_step app.workspace_purge_steps%ROWTYPE;
  v_count integer:=0; v_table text;
BEGIN
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid purge page' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job missing' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_step FROM app.workspace_purge_steps WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token IS DISTINCT FROM p_lease_token OR v_step.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_step.lease_expires_at IS NULL OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'purge lease stale' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_job.workspace_id AND status='purging'
    AND retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_job.workspace_id AND released_sequence IS NULL) THEN
    RAISE EXCEPTION 'legal hold blocks purge' USING ERRCODE='55000'; END IF;
  FOREACH v_table IN ARRAY ARRAY['workflow_favorite_receipts','workflow_favorite_held_evidence',
    'workflow_favorites','workflow_organization_receipts','workflow_tag_assignments',
    'workflow_organization_state','workflow_folders'] LOOP
    IF v_table='workflow_folders' THEN
      WITH candidates AS (SELECT f.ctid FROM app.workflow_folders f WHERE f.workspace_id=v_job.workspace_id
        AND NOT EXISTS(SELECT 1 FROM app.workflow_folders child WHERE child.workspace_id=f.workspace_id AND child.parent_id=f.id)
        ORDER BY f.id LIMIT p_page_size FOR UPDATE)
      DELETE FROM app.workflow_folders f USING candidates c WHERE f.ctid=c.ctid;
    ELSE
      EXECUTE format('WITH candidates AS(SELECT ctid FROM app.%I WHERE workspace_id=$1 LIMIT $2 FOR UPDATE)
        DELETE FROM app.%I r USING candidates c WHERE r.ctid=c.ctid',v_table,v_table)
        USING v_job.workspace_id,p_page_size;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_folders(
    p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $$;
ALTER FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) TO {{maintenance_role}};
