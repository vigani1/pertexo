-- ADR064: organization is not executable state or an authorization hierarchy.
-- Additive held-traffic cutover; the independent writer starts OFF.
CREATE TABLE app.workflow_organization_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  writes_enabled boolean NOT NULL DEFAULT false
);
INSERT INTO app.workflow_organization_rollout(singleton,writes_enabled) VALUES(true,false);
ALTER TABLE app.workflow_organization_rollout OWNER TO {{owner_role}};
REVOKE ALL ON app.workflow_organization_rollout FROM PUBLIC,{{api_runtime_role}},
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT SELECT ON app.workflow_organization_rollout TO {{api_runtime_role}};

CREATE TABLE app.workflow_organization_coordination (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces(id)
);
CREATE TABLE app.workflow_tags (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  id uuid NOT NULL,
  key text COLLATE "C" NOT NULL CHECK(octet_length(key) BETWEEN 1 AND 32
    AND key COLLATE "C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,key)
);
CREATE TABLE app.workflow_organization_state (
  workspace_id uuid NOT NULL, workflow_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(workspace_id,workflow_id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
);
CREATE TABLE app.workflow_tag_assignments (
  workspace_id uuid NOT NULL, workflow_id uuid NOT NULL, tag_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,workflow_id,tag_id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id),
  FOREIGN KEY(workspace_id,tag_id) REFERENCES app.workflow_tags(workspace_id,id)
);
CREATE INDEX workflow_tag_assignments_tag_idx
  ON app.workflow_tag_assignments(workspace_id,tag_id,workflow_id);

-- This child survives permanent membership status removal. Its restrictive
-- membership FK rejects unchecked physical deletion, never cascades held bytes.
-- Initial creation/removal use fresh UUIDs, so permitted recreation has no ABA.
CREATE TABLE app.workflow_favorite_membership_generations (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  actor_id uuid NOT NULL REFERENCES app.users(id),
  generation uuid NOT NULL,
  retired_at timestamptz,
  PRIMARY KEY(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES app.workspace_memberships(workspace_id,user_id)
);
CREATE INDEX workflow_favorite_membership_generations_actor_idx
  ON app.workflow_favorite_membership_generations(actor_id,workspace_id);
CREATE INDEX workflow_favorite_membership_generations_retired_idx
  ON app.workflow_favorite_membership_generations(retired_at,workspace_id,actor_id) WHERE retired_at IS NOT NULL;
CREATE INDEX workflow_favorite_membership_generations_workspace_retired_idx
  ON app.workflow_favorite_membership_generations(workspace_id,retired_at,actor_id) WHERE retired_at IS NOT NULL;

CREATE TABLE app.workflow_favorites (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, workflow_id uuid NOT NULL,
  generation uuid NOT NULL, favorite boolean NOT NULL, revision uuid NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY(workspace_id,actor_id,workflow_id),
  CHECK((favorite AND expires_at IS NULL) OR (NOT favorite AND expires_at IS NOT NULL)),
  FOREIGN KEY(workspace_id,actor_id)
    REFERENCES app.workflow_favorite_membership_generations(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
);
CREATE INDEX workflow_favorites_workflow_idx
  ON app.workflow_favorites(workspace_id,workflow_id,actor_id);
CREATE INDEX workflow_favorites_expiry_idx
  ON app.workflow_favorites(expires_at,workspace_id,actor_id,workflow_id) WHERE NOT favorite;
CREATE INDEX workflow_favorites_workspace_expiry_idx
  ON app.workflow_favorites(workspace_id,expires_at,actor_id,workflow_id) WHERE NOT favorite;
CREATE INDEX workflow_favorites_generation_idx
  ON app.workflow_favorites(workspace_id,actor_id,generation,workflow_id);

-- Only retired membership-generation evidence is relocated here; this is not
-- per-toggle history and has no serving-role read grant or bookmark projection.
CREATE TABLE app.workflow_favorite_held_evidence (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, workflow_id uuid NOT NULL,
  generation uuid NOT NULL, favorite boolean NOT NULL, revision uuid NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY(workspace_id,actor_id,workflow_id,generation),
  CHECK((favorite AND expires_at IS NULL) OR (NOT favorite AND expires_at IS NOT NULL)),
  FOREIGN KEY(workspace_id,actor_id)
    REFERENCES app.workflow_favorite_membership_generations(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
);
CREATE INDEX workflow_favorite_held_evidence_workflow_idx
  ON app.workflow_favorite_held_evidence(workspace_id,workflow_id,actor_id,generation);

CREATE TABLE app.workflow_organization_receipts (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id), actor_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('tag.create','tag.rename','tag.delete','tags.replace','tag.detach')),
  target_id uuid NOT NULL,
  key_hash char(64) NOT NULL CHECK(key_hash COLLATE "C" ~ '^[0-9a-f]{64}$'),
  request_hash char(64) NOT NULL CHECK(request_hash COLLATE "C" ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  PRIMARY KEY(workspace_id,actor_id,operation,target_id,key_hash),
  CHECK(expires_at>created_at), CHECK(result IS NULL OR octet_length(result::text)<=8192)
);
CREATE INDEX workflow_organization_receipts_expiry_idx
  ON app.workflow_organization_receipts(expires_at,workspace_id);
CREATE INDEX workflow_organization_receipts_workspace_expiry_idx
  ON app.workflow_organization_receipts(workspace_id,expires_at,actor_id,operation,target_id,key_hash);

-- Favorite results never enter generic workspace-visible idempotency/audit rows.
CREATE TABLE app.workflow_favorite_receipts (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, generation uuid NOT NULL,
  workflow_id uuid NOT NULL,
  key_hash char(64) NOT NULL CHECK(key_hash COLLATE "C" ~ '^[0-9a-f]{64}$'),
  request_hash char(64) NOT NULL CHECK(request_hash COLLATE "C" ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  -- The retained key also fences retired generations. Ignoring an old receipt
  -- would turn a delayed pre-departure "absent" request into a new command.
  PRIMARY KEY(workspace_id,actor_id,workflow_id,key_hash),
  FOREIGN KEY(workspace_id,actor_id)
    REFERENCES app.workflow_favorite_membership_generations(workspace_id,actor_id),
  -- Like existing command receipts, workflow visibility is checked explicitly.
  -- A workflow FK would acquire KEY SHARE before the coordinator during claim.
  CHECK(expires_at>created_at), CHECK(result IS NULL OR octet_length(result::text)<=512)
);
CREATE INDEX workflow_favorite_receipts_expiry_idx
  ON app.workflow_favorite_receipts(expires_at,workspace_id);
CREATE INDEX workflow_favorite_receipts_workspace_expiry_idx
  ON app.workflow_favorite_receipts(workspace_id,expires_at,actor_id,workflow_id,key_hash);
CREATE INDEX workflow_favorite_receipts_workflow_idx
  ON app.workflow_favorite_receipts(workspace_id,workflow_id,actor_id,generation);
CREATE INDEX workflow_favorite_receipts_generation_idx
  ON app.workflow_favorite_receipts(workspace_id,actor_id,generation,workflow_id);

ALTER TABLE app.workflow_organization_coordination ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_organization_coordination FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_tags FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_organization_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_organization_state FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_tag_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorite_membership_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorite_membership_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorite_held_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorite_held_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_organization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_organization_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorite_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_favorite_receipts FORCE ROW LEVEL SECURITY;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_organization_coordination','workflow_tags',
    'workflow_organization_state','workflow_tag_assignments',
    'workflow_favorite_membership_generations','workflow_favorites',
    'workflow_favorite_held_evidence','workflow_organization_receipts','workflow_favorite_receipts'] LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO %s',t,'{{owner_role}}');
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,%s,%s,%s,%s,%s,%s',t,
      '{{api_runtime_role}}','{{worker_runtime_role}}','{{dispatcher_role}}',
      '{{maintenance_role}}','{{operator_role}}','{{lifecycle_command_role}}');
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO %s USING(true) WITH CHECK(true)',
      t||'_owner',t,'{{owner_role}}');
  END LOOP;
END $$;

-- Read-only policy witness: scoped current authority, no row locks or writes.
CREATE FUNCTION app.current_workflow_favorite_generation() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
  SELECT g.generation FROM app.workflow_favorite_membership_generations g
  JOIN app.workspaces w ON w.id=g.workspace_id AND w.status='active'
  JOIN app.users u ON u.id=g.actor_id AND u.status='active'
  JOIN app.workspace_memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.actor_id AND m.status='active'
  WHERE g.workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND g.actor_id::text=nullif(current_setting('app.actor_id',true),'')
$$;
ALTER FUNCTION app.current_workflow_favorite_generation() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.current_workflow_favorite_generation() FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.current_workflow_favorite_generation() TO {{api_runtime_role}};

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_tags','workflow_organization_state','workflow_tag_assignments'] LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO %s USING(
      workspace_id::text=nullif(current_setting(''app.workspace_id'',true),'''')
      AND EXISTS(SELECT 1 FROM app.workspaces w JOIN app.workspace_memberships m ON m.workspace_id=w.id
        JOIN app.users u ON u.id=m.user_id WHERE w.id=%I.workspace_id AND w.status=''active''
        AND m.user_id::text=nullif(current_setting(''app.actor_id'',true),'''')
        AND m.status=''active'' AND u.status=''active''))',t||'_reader',t,'{{api_runtime_role}}',t);
    EXECUTE format('GRANT SELECT ON app.%I TO %s',t,'{{api_runtime_role}}');
  END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_favorites','workflow_favorite_receipts'] LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I FOR SELECT TO %s USING(
      workspace_id::text=nullif(current_setting(''app.workspace_id'',true),'''')
      AND actor_id::text=nullif(current_setting(''app.actor_id'',true),'''')
      AND generation=app.current_workflow_favorite_generation())',t||'_actor',t,'{{api_runtime_role}}');
    EXECUTE format('GRANT SELECT ON app.%I TO %s',t,'{{api_runtime_role}}');
  END LOOP;
END $$;

-- Trigger covers removal, self-leave and direct privileged status projection
-- without an unbounded favorite scan. A missing generation still gets a fence.
CREATE FUNCTION app.invalidate_workflow_favorite_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
BEGIN
  IF NEW.status='removed' AND OLD.status IS DISTINCT FROM 'removed' THEN
    INSERT INTO app.workflow_favorite_membership_generations(workspace_id,actor_id,generation,retired_at)
      VALUES(NEW.workspace_id,NEW.user_id,uuidv7(),clock_timestamp())
      ON CONFLICT(workspace_id,actor_id) DO UPDATE SET generation=EXCLUDED.generation,retired_at=EXCLUDED.retired_at;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.invalidate_workflow_favorite_membership() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.invalidate_workflow_favorite_membership() FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
CREATE TRIGGER workflow_favorite_membership_departure AFTER UPDATE OF status
  ON app.workspace_memberships FOR EACH ROW EXECUTE FUNCTION app.invalidate_workflow_favorite_membership();

-- All mutating commands and the lifecycle adapter take explicit ordered locks,
-- rather than relying on a joined FOR SHARE executor's incidental lock order.
CREATE FUNCTION app.lock_workflow_organization_authority(p_roles text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_actor uuid;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  IF v_workspace IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.users WHERE id=v_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace AND user_id=v_actor
    AND status='active' AND role=ANY(p_roles) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  RETURN v_workspace;
END $$;
ALTER FUNCTION app.lock_workflow_organization_authority(text[]) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_workflow_organization_authority(text[]) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE FUNCTION app.lock_workflow_organization_coordination(p_exclusive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  IF v_workspace IS NULL OR p_exclusive IS NULL THEN
    RAISE EXCEPTION 'organization scope invalid' USING ERRCODE='22023'; END IF;
  INSERT INTO app.workflow_organization_coordination(workspace_id) VALUES(v_workspace)
    ON CONFLICT(workspace_id) DO NOTHING;
  IF p_exclusive THEN
    PERFORM 1 FROM app.workflow_organization_coordination WHERE workspace_id=v_workspace FOR UPDATE;
  ELSE
    PERFORM 1 FROM app.workflow_organization_coordination WHERE workspace_id=v_workspace FOR SHARE;
  END IF;
END $$;
ALTER FUNCTION app.lock_workflow_organization_coordination(boolean) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_workflow_organization_coordination(boolean) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE FUNCTION app.lock_workflow_organization_for_lifecycle() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
BEGIN
  PERFORM app.lock_workflow_organization_authority(ARRAY['owner','admin','builder']);
  PERFORM app.lock_workflow_organization_coordination(false);
END $$;
ALTER FUNCTION app.lock_workflow_organization_for_lifecycle() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_workflow_organization_for_lifecycle() FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.lock_workflow_organization_for_lifecycle() TO {{api_runtime_role}};

CREATE FUNCTION app.assert_workflow_organization_writes_enabled() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_enabled boolean;
BEGIN
  SELECT writes_enabled INTO v_enabled FROM app.workflow_organization_rollout WHERE singleton FOR SHARE;
  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow organization writes unavailable' USING ERRCODE='P7001'; END IF;
END $$;
ALTER FUNCTION app.assert_workflow_organization_writes_enabled() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.assert_workflow_organization_writes_enabled() FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE FUNCTION app.claim_workflow_organization_command(
  p_operation text,p_target uuid,p_key_hash text,p_request jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_actor uuid; v_hash text; v_receipt app.workflow_organization_receipts%ROWTYPE;
BEGIN
  IF p_key_hash IS NULL OR octet_length(p_key_hash)<>64
    OR p_key_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'organization command identity invalid' USING ERRCODE='22023'; END IF;
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  v_hash:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
  INSERT INTO app.workflow_organization_receipts(workspace_id,actor_id,operation,target_id,key_hash,request_hash)
    VALUES(v_workspace,v_actor,p_operation,p_target,p_key_hash,v_hash)
    ON CONFLICT(workspace_id,actor_id,operation,target_id,key_hash) DO NOTHING;
  SELECT * INTO STRICT v_receipt FROM app.workflow_organization_receipts
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND operation=p_operation
      AND target_id=p_target AND key_hash=p_key_hash FOR UPDATE;
  IF v_receipt.request_hash<>v_hash THEN
    RAISE EXCEPTION 'organization command identity conflict' USING ERRCODE='P7002'; END IF;
  RETURN v_receipt.result;
END $$;
ALTER FUNCTION app.claim_workflow_organization_command(text,uuid,text,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_workflow_organization_command(text,uuid,text,jsonb) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE FUNCTION app.complete_workflow_organization_command(
  p_operation text,p_target uuid,p_key_hash text,p_result jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
BEGIN
  UPDATE app.workflow_organization_receipts SET result=p_result
    WHERE workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
      AND actor_id::text=nullif(current_setting('app.actor_id',true),'')
      AND operation=p_operation AND target_id=p_target AND key_hash=p_key_hash AND result IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization claim unavailable' USING ERRCODE='55000'; END IF;
END $$;
ALTER FUNCTION app.complete_workflow_organization_command(text,uuid,text,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.complete_workflow_organization_command(text,uuid,text,jsonb) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE FUNCTION app.record_workflow_organization_audit(p_action text,p_target uuid,p_metadata jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
  INSERT INTO app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,metadata)
  VALUES(uuidv7(),nullif(current_setting('app.workspace_id',true),'')::uuid,
    nullif(current_setting('app.actor_id',true),'')::uuid,p_action,'workflow_organization',p_target,p_metadata)
$$;
ALTER FUNCTION app.record_workflow_organization_audit(text,uuid,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.record_workflow_organization_audit(text,uuid,jsonb) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

-- Owner/admin vocabulary mutation. Successful replay never selects a tag or
-- current writer gate: rename/delete can replay after the tag was removed.
CREATE FUNCTION app.execute_workflow_tag_command(
  p_operation text,p_tag_id uuid,p_key_hash text,p_body jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_key text; v_expected bigint; v_request jsonb;
  v_target uuid; v_replay jsonb; v_result jsonb; v_tag app.workflow_tags%ROWTYPE;
  v_workflows uuid[]; v_workflow uuid; v_revision bigint;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('tag.create','tag.rename','tag.delete')
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>256
    OR (p_operation='tag.create' AND p_tag_id IS NOT NULL)
    OR (p_operation<>'tag.create' AND p_tag_id IS NULL) THEN
    RAISE EXCEPTION 'tag command invalid' USING ERRCODE='22023'; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_body) key)
    IS DISTINCT FROM (CASE p_operation WHEN 'tag.create' THEN ARRAY['key']::text[]
      WHEN 'tag.rename' THEN ARRAY['expectedTagRevision','key']::text[]
      ELSE ARRAY['expectedTagRevision']::text[] END) THEN
    RAISE EXCEPTION 'tag command invalid' USING ERRCODE='22023'; END IF;
  IF p_operation<>'tag.delete' THEN
    IF jsonb_typeof(p_body->'key') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'tag key invalid' USING ERRCODE='22023'; END IF;
    v_key:=translate(btrim(p_body->>'key',' '),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
    IF octet_length(v_key) NOT BETWEEN 1 AND 32 OR v_key COLLATE "C" !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      OR v_key COLLATE "C" ~ '[^a-z0-9-]' THEN
      RAISE EXCEPTION 'tag key invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_operation<>'tag.create' THEN
    IF jsonb_typeof(p_body->'expectedTagRevision') IS DISTINCT FROM 'number'
      OR (p_body->>'expectedTagRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
      OR trunc((p_body->>'expectedTagRevision')::numeric)<>(p_body->>'expectedTagRevision')::numeric THEN
      RAISE EXCEPTION 'tag revision invalid' USING ERRCODE='22023'; END IF;
    v_expected:=(p_body->>'expectedTagRevision')::bigint;
  END IF;
  v_request:=CASE p_operation WHEN 'tag.create' THEN jsonb_build_object('key',v_key)
    WHEN 'tag.rename' THEN jsonb_build_object('key',v_key,'expectedTagRevision',v_expected)
    ELSE jsonb_build_object('expectedTagRevision',v_expected) END;
  v_target:=coalesce(p_tag_id,'00000000-0000-0000-0000-000000000000'::uuid);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin']);
  v_replay:=app.claim_workflow_organization_command(p_operation,v_target,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN RETURN v_replay||jsonb_build_object('replayed',true); END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(true);

  IF p_operation='tag.create' THEN
    IF EXISTS(SELECT 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND key=v_key) THEN
      RAISE EXCEPTION 'tag key conflict' USING ERRCODE='P7003'; END IF;
    IF (SELECT count(*) FROM app.workflow_tags WHERE workspace_id=v_workspace)>=256 THEN
      RAISE EXCEPTION 'workspace tag limit' USING ERRCODE='P7004'; END IF;
    INSERT INTO app.workflow_tags(workspace_id,id,key) VALUES(v_workspace,uuidv7(),v_key)
      RETURNING * INTO v_tag;
    v_result:=jsonb_build_object('tag',jsonb_build_object('id',v_tag.id,'key',v_tag.key,'revision',v_tag.revision));
  ELSE
    SELECT * INTO v_tag FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=p_tag_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'tag is not visible' USING ERRCODE='P7005'; END IF;
    IF v_tag.revision<>v_expected THEN
      RAISE EXCEPTION 'tag revision conflict' USING ERRCODE='P7006',DETAIL=v_tag.revision::text; END IF;
    IF p_operation='tag.rename' THEN
      IF EXISTS(SELECT 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND key=v_key AND id<>p_tag_id) THEN
        RAISE EXCEPTION 'tag key conflict' USING ERRCODE='P7003'; END IF;
      IF v_tag.revision=9007199254740991 THEN
        RAISE EXCEPTION 'tag revision exhausted' USING ERRCODE='P7006',DETAIL=v_tag.revision::text; END IF;
      UPDATE app.workflow_tags SET key=v_key,revision=revision+1
        WHERE workspace_id=v_workspace AND id=p_tag_id RETURNING * INTO v_tag;
      v_result:=jsonb_build_object('tag',jsonb_build_object('id',v_tag.id,'key',v_tag.key,'revision',v_tag.revision));
    ELSE
      SELECT coalesce(array_agg(workflow_id ORDER BY workflow_id),ARRAY[]::uuid[]) INTO v_workflows
        FROM (SELECT workflow_id FROM app.workflow_tag_assignments
          WHERE workspace_id=v_workspace AND tag_id=p_tag_id ORDER BY workflow_id LIMIT 51) bounded;
      IF cardinality(v_workflows)>50 THEN
        RAISE EXCEPTION 'tag deletion requires bounded cleanup' USING ERRCODE='P7007'; END IF;
      -- Every workflow lock is later than the coordinator/tag/51-row preflight.
      PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=ANY(v_workflows) ORDER BY id FOR UPDATE;
      FOREACH v_workflow IN ARRAY v_workflows LOOP
        SELECT revision INTO v_revision FROM app.workflow_organization_state
          WHERE workspace_id=v_workspace AND workflow_id=v_workflow;
        IF v_revision=9007199254740991 THEN
          RAISE EXCEPTION 'organization revision exhausted' USING ERRCODE='P7008'; END IF;
        INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision) VALUES(v_workspace,v_workflow,2)
          ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET revision=app.workflow_organization_state.revision+1;
      END LOOP;
      DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND tag_id=p_tag_id;
      DELETE FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=p_tag_id;
      v_result:=jsonb_build_object('tagId',p_tag_id,'deleted',true,'detachedWorkflowCount',cardinality(v_workflows));
    END IF;
  END IF;
  PERFORM app.record_workflow_organization_audit('workflow.'||p_operation,
    CASE WHEN p_operation='tag.create' THEN v_tag.id ELSE p_tag_id END,
    CASE WHEN p_operation='tag.delete' THEN jsonb_build_object('detachedWorkflowCount',cardinality(v_workflows))
      ELSE jsonb_build_object('revision',v_tag.revision) END);
  PERFORM app.complete_workflow_organization_command(p_operation,v_target,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;
ALTER FUNCTION app.execute_workflow_tag_command(text,uuid,text,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.execute_workflow_tag_command(text,uuid,text,jsonb) FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.execute_workflow_tag_command(text,uuid,text,jsonb) TO {{api_runtime_role}};

-- Cleanup items use this same per-workflow transaction with an explicit
-- owner/admin-only operation; archived targets are permitted only for detach.
CREATE FUNCTION app.execute_workflow_tag_assignment_command(
  p_operation text,p_workflow_id uuid,p_key_hash text,p_body jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_roles text[]; v_ids uuid[]; v_expected bigint;
  v_lifecycle text; v_revision bigint; v_replay jsonb; v_result jsonb; v_request jsonb;
  v_input jsonb; v_id uuid; v_keys text[];
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('tags.replace','tag.detach') OR p_workflow_id IS NULL
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>2048 THEN
    RAISE EXCEPTION 'tag assignment command invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO v_keys FROM jsonb_object_keys(p_body) key;
  IF v_keys IS DISTINCT FROM (CASE p_operation WHEN 'tags.replace'
    THEN ARRAY['expectedOrganizationRevision','tagIds']::text[]
    ELSE ARRAY['expectedOrganizationRevision','tagId']::text[] END) THEN
    RAISE EXCEPTION 'tag assignment command invalid' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_body->'expectedOrganizationRevision') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'organization revision invalid' USING ERRCODE='22023'; END IF;
  IF (p_body->>'expectedOrganizationRevision')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR trunc((p_body->>'expectedOrganizationRevision')::numeric)<>(p_body->>'expectedOrganizationRevision')::numeric THEN
    RAISE EXCEPTION 'organization revision invalid' USING ERRCODE='22023'; END IF;
  v_expected:=(p_body->>'expectedOrganizationRevision')::bigint;
  IF p_operation='tags.replace' THEN
    IF jsonb_typeof(p_body->'tagIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_body->'tagIds')>16 THEN
      RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
    v_input:=p_body->'tagIds'; v_roles:=ARRAY['owner','admin','builder'];
  ELSE
    v_input:=jsonb_build_array(p_body->'tagId'); v_roles:=ARRAY['owner','admin'];
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_input) item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string' OR octet_length(item#>>'{}')<>36
      OR (item#>>'{}') COLLATE "C" !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') THEN
    RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT (item#>>'{}')::uuid id FROM jsonb_array_elements(v_input) item) ids;
  IF cardinality(v_ids)<>(SELECT count(DISTINCT id) FROM unnest(v_ids) id) THEN
    RAISE EXCEPTION 'tag selection invalid' USING ERRCODE='22023'; END IF;
  v_request:=CASE p_operation WHEN 'tags.replace'
    THEN jsonb_build_object('tagIds',to_jsonb(v_ids),'expectedOrganizationRevision',v_expected)
    ELSE jsonb_build_object('tagId',v_ids[1],'expectedOrganizationRevision',v_expected) END;
  v_workspace:=app.lock_workflow_organization_authority(v_roles);
  v_replay:=app.claim_workflow_organization_command(p_operation,p_workflow_id,p_key_hash,v_request);
  IF v_replay IS NOT NULL THEN
    -- Current visibility without coordinator/tag locks or current selection.
    PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(true);
  PERFORM 1 FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_ids) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM app.workflow_tags WHERE workspace_id=v_workspace AND id=ANY(v_ids))<>cardinality(v_ids) THEN
    RAISE EXCEPTION 'tag is not visible' USING ERRCODE='P7005'; END IF;
  SELECT lifecycle_status INTO v_lifecycle FROM app.workflows
    WHERE workspace_id=v_workspace AND id=p_workflow_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  IF p_operation='tags.replace' AND v_lifecycle<>'active' THEN
    RAISE EXCEPTION 'workflow lifecycle conflict' USING ERRCODE='P7009'; END IF;
  SELECT revision INTO v_revision FROM app.workflow_organization_state
    WHERE workspace_id=v_workspace AND workflow_id=p_workflow_id;
  v_revision:=coalesce(v_revision,1);
  IF v_revision<>v_expected OR v_revision=9007199254740991 THEN
    RAISE EXCEPTION 'organization revision conflict' USING ERRCODE='P7008',DETAIL=v_revision::text; END IF;
  IF p_operation='tags.replace' THEN
    DELETE FROM app.workflow_tag_assignments WHERE workspace_id=v_workspace AND workflow_id=p_workflow_id;
    FOREACH v_id IN ARRAY v_ids LOOP
      INSERT INTO app.workflow_tag_assignments(workspace_id,workflow_id,tag_id) VALUES(v_workspace,p_workflow_id,v_id);
    END LOOP;
  ELSE
    DELETE FROM app.workflow_tag_assignments
      WHERE workspace_id=v_workspace AND workflow_id=p_workflow_id AND tag_id=v_ids[1];
  END IF;
  INSERT INTO app.workflow_organization_state(workspace_id,workflow_id,revision)
    VALUES(v_workspace,p_workflow_id,v_revision+1)
    ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET revision=EXCLUDED.revision;
  v_result:=jsonb_build_object('workflowId',p_workflow_id,'organizationRevision',v_revision+1);
  IF p_operation='tags.replace' THEN v_result:=v_result||jsonb_build_object('tagIds',to_jsonb(v_ids)); END IF;
  PERFORM app.record_workflow_organization_audit('workflow.'||p_operation,p_workflow_id,
    jsonb_build_object('organizationRevision',v_revision+1));
  PERFORM app.complete_workflow_organization_command(p_operation,p_workflow_id,p_key_hash,v_result);
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;
ALTER FUNCTION app.execute_workflow_tag_assignment_command(text,uuid,text,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.execute_workflow_tag_assignment_command(text,uuid,text,jsonb) FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.execute_workflow_tag_assignment_command(text,uuid,text,jsonb) TO {{api_runtime_role}};

CREATE FUNCTION app.lock_workflow_favorite_generation(p_update boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_actor uuid; v_generation uuid;
BEGIN
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  INSERT INTO app.workflow_favorite_membership_generations(workspace_id,actor_id,generation)
    VALUES(v_workspace,v_actor,uuidv7()) ON CONFLICT(workspace_id,actor_id) DO NOTHING;
  IF p_update THEN
    SELECT generation INTO STRICT v_generation FROM app.workflow_favorite_membership_generations
      WHERE workspace_id=v_workspace AND actor_id=v_actor FOR UPDATE;
  ELSE
    SELECT generation INTO STRICT v_generation FROM app.workflow_favorite_membership_generations
      WHERE workspace_id=v_workspace AND actor_id=v_actor FOR SHARE;
  END IF;
  RETURN v_generation;
END $$;
ALTER FUNCTION app.lock_workflow_favorite_generation(boolean) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_workflow_favorite_generation(boolean) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

-- Projection adapters keep this generation internal, issue an authenticated
-- absence token, then remove both fields before strict HTTP serialization.
CREATE FUNCTION app.read_workflow_favorite_generation() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_generation uuid;
BEGIN
  PERFORM app.lock_workflow_organization_authority(ARRAY['owner','admin','builder','operator','viewer']);
  v_generation:=app.lock_workflow_favorite_generation(false);
  RETURN jsonb_build_object('generation',v_generation,
    'readAtSeconds',floor(extract(epoch FROM clock_timestamp()))::bigint);
END $$;
ALTER FUNCTION app.read_workflow_favorite_generation() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.read_workflow_favorite_generation() FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.read_workflow_favorite_generation() TO {{api_runtime_role}};

CREATE FUNCTION app.workflow_favorite_command_body(p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_expected text;
BEGIN
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>256 THEN
    RAISE EXCEPTION 'favorite command invalid' USING ERRCODE='22023'; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_body) key)
    IS DISTINCT FROM ARRAY['expectedFavoriteRevision','favorite']::text[]
    OR jsonb_typeof(p_body->'favorite') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_body->'expectedFavoriteRevision') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'favorite command invalid' USING ERRCODE='22023'; END IF;
  v_expected:=p_body->>'expectedFavoriteRevision';
  IF octet_length(v_expected)=36 AND v_expected COLLATE "C" ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
    v_expected:=v_expected::uuid::text;
  ELSIF octet_length(v_expected)>128 OR v_expected COLLATE "C" !~ '^absent[.]v1[.](0|[1-9][0-9]{0,11})[.](0|[1-9][0-9]{0,11})[.][A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    OR v_expected COLLATE "C" ~ '[^A-Za-z0-9_.-]' THEN
    RAISE EXCEPTION 'favorite precondition invalid' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('favorite',p_body->'favorite','expectedFavoriteRevision',v_expected);
END $$;
ALTER FUNCTION app.workflow_favorite_command_body(jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_favorite_command_body(jsonb) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

-- Must run within the same tenant transaction as the execution below. This
-- receipt-first phase returns a committed replay before transport token MAC,
-- expiry, key rotation or writer policy can invalidate exact recovery.
CREATE FUNCTION app.prepare_workflow_favorite_command(p_workflow_id uuid,p_key_hash text,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_actor uuid; v_generation uuid; v_request jsonb;
  v_hash text; v_receipt app.workflow_favorite_receipts%ROWTYPE;
BEGIN
  IF p_workflow_id IS NULL OR p_key_hash IS NULL OR octet_length(p_key_hash)<>64
    OR p_key_hash COLLATE "C" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'favorite command identity invalid' USING ERRCODE='22023'; END IF;
  v_request:=app.workflow_favorite_command_body(p_body);
  v_workspace:=app.lock_workflow_organization_authority(ARRAY['owner','admin','builder','operator','viewer']);
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  v_generation:=app.lock_workflow_favorite_generation(true);
  -- A visibility read need not take a workflow lock before the coordinator.
  PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  v_hash:=encode(sha256(convert_to(v_request::text,'UTF8')),'hex');
  INSERT INTO app.workflow_favorite_receipts(workspace_id,actor_id,generation,workflow_id,key_hash,request_hash)
    VALUES(v_workspace,v_actor,v_generation,p_workflow_id,p_key_hash,v_hash)
    ON CONFLICT(workspace_id,actor_id,workflow_id,key_hash) DO NOTHING;
  SELECT * INTO STRICT v_receipt FROM app.workflow_favorite_receipts
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND workflow_id=p_workflow_id AND key_hash=p_key_hash FOR UPDATE;
  IF v_receipt.generation<>v_generation THEN
    RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  IF v_receipt.request_hash<>v_hash THEN
    RAISE EXCEPTION 'favorite command identity conflict' USING ERRCODE='P7002'; END IF;
  IF v_receipt.result IS NOT NULL THEN
    PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('kind','replay','result',v_receipt.result||jsonb_build_object('replayed',true));
  END IF;
  RETURN jsonb_build_object('kind','new','generation',v_generation);
END $$;
ALTER FUNCTION app.prepare_workflow_favorite_command(uuid,text,jsonb) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.prepare_workflow_favorite_command(uuid,text,jsonb) FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.prepare_workflow_favorite_command(uuid,text,jsonb) TO {{api_runtime_role}};

-- Transport proof is derived only by the authenticated adapter after MAC
-- validation against the prepared server generation. It is never an HTTP field.
-- SQL rechecks locked authority/generation/body identity, absence and DB time.
CREATE FUNCTION app.execute_workflow_favorite_command(
  p_workflow_id uuid,p_key_hash text,p_body jsonb,p_verified_generation uuid,
  p_issued_seconds bigint,p_expires_seconds bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_claim jsonb; v_workspace uuid; v_actor uuid; v_generation uuid;
  v_request jsonb; v_expected text; v_now numeric; v_current app.workflow_favorites%ROWTYPE;
  v_revision uuid; v_result jsonb; v_favorite boolean;
BEGIN
  v_claim:=app.prepare_workflow_favorite_command(p_workflow_id,p_key_hash,p_body);
  IF v_claim->>'kind'='replay' THEN RETURN v_claim->'result'; END IF;
  v_workspace:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  v_generation:=(v_claim->>'generation')::uuid;
  v_request:=app.workflow_favorite_command_body(p_body);
  v_expected:=v_request->>'expectedFavoriteRevision';
  v_favorite:=(v_request->>'favorite')::boolean;
  PERFORM app.assert_workflow_organization_writes_enabled();
  PERFORM app.lock_workflow_organization_coordination(false);
  PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=p_workflow_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow is not visible' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_current FROM app.workflow_favorites
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND workflow_id=p_workflow_id FOR UPDATE;
  IF left(v_expected,10)='absent.v1.' THEN
    v_now:=extract(epoch FROM clock_timestamp());
    IF p_verified_generation IS DISTINCT FROM v_generation
      OR (v_current.generation=v_generation)
      OR p_issued_seconds IS NULL OR p_expires_seconds IS NULL
      OR p_issued_seconds<0 OR p_expires_seconds>253402300799
      OR p_expires_seconds-p_issued_seconds<>86400
      OR p_issued_seconds>v_now+5 OR p_expires_seconds<=v_now
      OR split_part(v_expected,'.',3)<>p_issued_seconds::text
      OR split_part(v_expected,'.',4)<>p_expires_seconds::text THEN
      RAISE EXCEPTION 'favorite revision conflict' USING ERRCODE='P7010'; END IF;
  ELSE
    IF p_verified_generation IS NOT NULL OR p_issued_seconds IS NOT NULL OR p_expires_seconds IS NOT NULL
      OR v_current.generation IS DISTINCT FROM v_generation
      OR v_current.revision::text IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'favorite revision conflict' USING ERRCODE='P7010'; END IF;
  END IF;
  IF v_current.generation IS NOT NULL AND v_current.generation<>v_generation
    AND EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN
    INSERT INTO app.workflow_favorite_held_evidence(workspace_id,actor_id,workflow_id,generation,favorite,revision,expires_at)
      VALUES(v_current.workspace_id,v_current.actor_id,v_current.workflow_id,v_current.generation,
        v_current.favorite,v_current.revision,v_current.expires_at);
  END IF;
  v_revision:=uuidv7();
  INSERT INTO app.workflow_favorites(workspace_id,actor_id,workflow_id,generation,favorite,revision,expires_at)
    VALUES(v_workspace,v_actor,p_workflow_id,v_generation,v_favorite,v_revision,
      CASE WHEN v_favorite THEN NULL ELSE clock_timestamp()+interval '24 hours' END)
    ON CONFLICT(workspace_id,actor_id,workflow_id) DO UPDATE SET generation=EXCLUDED.generation,
      favorite=EXCLUDED.favorite,revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at;
  v_result:=jsonb_build_object('isFavorite',v_favorite,'favoriteRevision',v_revision);
  UPDATE app.workflow_favorite_receipts SET result=v_result
    WHERE workspace_id=v_workspace AND actor_id=v_actor AND workflow_id=p_workflow_id
      AND key_hash=p_key_hash AND generation=v_generation AND result IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'favorite claim unavailable' USING ERRCODE='55000'; END IF;
  RETURN v_result||jsonb_build_object('replayed',false);
END $$;
ALTER FUNCTION app.execute_workflow_favorite_command(uuid,text,jsonb,uuid,bigint,bigint) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.execute_workflow_favorite_command(uuid,text,jsonb,uuid,bigint,bigint) FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.execute_workflow_favorite_command(uuid,text,jsonb,uuid,bigint,bigint) TO {{api_runtime_role}};

-- One eligible workspace and one shared row budget. Retired generation markers
-- avoid a global scan of every current private bookmark to discover departure.
CREATE FUNCTION app.reap_workflow_organization(p_limit integer DEFAULT 100)
RETURNS TABLE(favorites_deleted integer,evidence_deleted integer,private_receipts_deleted integer,
  shared_receipts_deleted integer,generations_cleared integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_favorites integer:=0; v_evidence integer:=0;
  v_private integer:=0; v_shared integer:=0; v_generations integer:=0;
  v_retired_actor uuid; v_retired_generation uuid; v_expired integer:=0;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'organization cleanup limit invalid' USING ERRCODE='22023'; END IF;
  SELECT workspace_id INTO v_workspace FROM (
    (SELECT f.workspace_id FROM app.workflow_favorites f WHERE NOT f.favorite AND f.expires_at<=v_now
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=f.workspace_id AND h.released_sequence IS NULL)
      ORDER BY f.expires_at,f.workspace_id,f.actor_id,f.workflow_id LIMIT 1)
    UNION ALL
    (SELECT r.workspace_id FROM app.workflow_favorite_receipts r WHERE r.expires_at<=v_now
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=r.workspace_id AND h.released_sequence IS NULL)
      ORDER BY r.expires_at,r.workspace_id LIMIT 1)
    UNION ALL
    (SELECT r.workspace_id FROM app.workflow_organization_receipts r WHERE r.expires_at<=v_now
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=r.workspace_id AND h.released_sequence IS NULL)
      ORDER BY r.expires_at,r.workspace_id LIMIT 1)
    UNION ALL
    (SELECT g.workspace_id FROM app.workflow_favorite_membership_generations g WHERE g.retired_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds h WHERE h.workspace_id=g.workspace_id AND h.released_sequence IS NULL)
      ORDER BY g.retired_at,g.workspace_id,g.actor_id LIMIT 1)
  ) candidates ORDER BY workspace_id LIMIT 1;
  IF v_workspace IS NULL THEN RETURN QUERY SELECT 0,0,0,0,0; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_workspace::text,1934781127));
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN
    RETURN QUERY SELECT 0,0,0,0,0; RETURN; END IF;
  v_now:=clock_timestamp();
  -- Expired false state is sought directly by the workspace/expiry index.
  -- Never filter every current true bookmark to discover a small expired batch.
  WITH candidates AS (
    SELECT ctid FROM app.workflow_favorites WHERE workspace_id=v_workspace
      AND NOT favorite AND expires_at<=v_now
    ORDER BY expires_at,actor_id,workflow_id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_favorites f USING candidates c WHERE f.ctid=c.ctid;
  GET DIAGNOSTICS v_expired=ROW_COUNT;
  v_favorites:=v_expired;
  -- One indexed retirement marker; generation range seeks exclude the entire
  -- current generation rather than testing every current bookmark with <>.
  SELECT actor_id,generation INTO v_retired_actor,v_retired_generation
    FROM app.workflow_favorite_membership_generations
    WHERE workspace_id=v_workspace AND retired_at IS NOT NULL
    ORDER BY retired_at,actor_id LIMIT 1 FOR UPDATE;
  IF v_retired_actor IS NOT NULL THEN
    WITH below AS MATERIALIZED (
      SELECT ctid FROM app.workflow_favorites WHERE workspace_id=v_workspace
        AND actor_id=v_retired_actor AND generation<v_retired_generation
        ORDER BY generation,workflow_id LIMIT p_limit-v_favorites
    ), above AS MATERIALIZED (
      SELECT ctid FROM app.workflow_favorites WHERE workspace_id=v_workspace
        AND actor_id=v_retired_actor AND generation>v_retired_generation
        ORDER BY generation,workflow_id LIMIT p_limit-v_favorites
    ), candidates AS (SELECT ctid FROM below UNION ALL SELECT ctid FROM above),
    bounded AS (SELECT f.ctid FROM app.workflow_favorites f JOIN candidates c ON f.ctid=c.ctid
      LIMIT p_limit-v_favorites FOR UPDATE OF f SKIP LOCKED)
    DELETE FROM app.workflow_favorites f USING bounded c WHERE f.ctid=c.ctid;
    GET DIAGNOSTICS v_expired=ROW_COUNT;
    v_favorites:=v_favorites+v_expired;
  END IF;
  WITH candidates AS (
    SELECT ctid FROM app.workflow_favorite_held_evidence WHERE workspace_id=v_workspace
      ORDER BY actor_id,workflow_id,generation LIMIT p_limit-v_favorites FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_favorite_held_evidence e USING candidates c WHERE e.ctid=c.ctid;
  GET DIAGNOSTICS v_evidence=ROW_COUNT;
  WITH candidates AS (
    SELECT ctid FROM app.workflow_favorite_receipts WHERE workspace_id=v_workspace AND expires_at<=v_now
    ORDER BY expires_at,actor_id,workflow_id,key_hash LIMIT p_limit-v_favorites-v_evidence FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_favorite_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_private=ROW_COUNT;
  WITH candidates AS (
    SELECT ctid FROM app.workflow_organization_receipts WHERE workspace_id=v_workspace AND expires_at<=v_now
      ORDER BY expires_at,actor_id,operation,target_id,key_hash LIMIT p_limit-v_favorites-v_evidence-v_private FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.workflow_organization_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_shared=ROW_COUNT;
  -- The marker tracks old state/evidence, not receipts. Unexpired private
  -- receipts retain their generation/key fence and own expiry index regardless
  -- of marker clearing; the current generation itself is never deleted/reset.
  IF v_retired_actor IS NOT NULL AND p_limit-v_favorites-v_evidence-v_private-v_shared>0
    AND NOT EXISTS(SELECT 1 FROM app.workflow_favorites WHERE workspace_id=v_workspace
      AND actor_id=v_retired_actor AND generation<v_retired_generation)
    AND NOT EXISTS(SELECT 1 FROM app.workflow_favorites WHERE workspace_id=v_workspace
      AND actor_id=v_retired_actor AND generation>v_retired_generation)
    AND NOT EXISTS(SELECT 1 FROM app.workflow_favorite_held_evidence WHERE workspace_id=v_workspace AND actor_id=v_retired_actor) THEN
    UPDATE app.workflow_favorite_membership_generations SET retired_at=NULL
      WHERE workspace_id=v_workspace AND actor_id=v_retired_actor;
    GET DIAGNOSTICS v_generations=ROW_COUNT;
  END IF;
  RETURN QUERY SELECT v_favorites,v_evidence,v_private,v_shared,v_generations;
END $$;
ALTER FUNCTION app.reap_workflow_organization(integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.reap_workflow_organization(integer) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.reap_workflow_organization(integer) TO {{maintenance_role}};

ALTER FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)
  RENAME TO execute_workspace_tenant_rows_page_before_organization;
REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page_before_organization(uuid,uuid,bigint,integer,bigint,char)
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
  -- The canonical purge coordinator owns the existing destructive SESSION lock
  -- before this transaction. Never reacquire it here on another connection.
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
  -- Exactly one confined relation/page per call; no caller-chosen relation and
  -- no FK cascade bypass of the shared page budget or current hold check.
  FOREACH v_table IN ARRAY ARRAY['workflow_favorite_receipts','workflow_favorite_held_evidence',
    'workflow_favorites','workflow_organization_receipts','workflow_tag_assignments',
    'workflow_organization_state','workflow_tags','workflow_favorite_membership_generations',
    'workflow_organization_coordination'] LOOP
    EXECUTE format('WITH candidates AS(SELECT ctid FROM app.%I WHERE workspace_id=$1 LIMIT $2 FOR UPDATE)
      DELETE FROM app.%I r USING candidates c WHERE r.ctid=c.ctid',v_table,v_table)
      USING v_job.workspace_id,p_page_size;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_organization(
    p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $$;
ALTER FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) TO {{maintenance_role}};
