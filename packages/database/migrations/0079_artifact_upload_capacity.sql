-- ADR 035: PostgreSQL-authoritative artifact capacity and public-upload
-- metadata. Every artifact writer reserves through the same row lock; object
-- storage verification remains outside this transaction.

CREATE TABLE app.workspace_artifact_capacity (
  workspace_id uuid PRIMARY KEY,
  byte_limit bigint NOT NULL DEFAULT 1073741824,
  artifact_count_limit integer NOT NULL DEFAULT 1000,
  charged_bytes bigint NOT NULL DEFAULT 0,
  charged_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_artifact_capacity_byte_limit_valid
    CHECK (byte_limit >= 0),
  CONSTRAINT workspace_artifact_capacity_count_limit_valid
    CHECK (artifact_count_limit >= 0),
  CONSTRAINT workspace_artifact_capacity_charged_bytes_valid
    CHECK (charged_bytes >= 0),
  CONSTRAINT workspace_artifact_capacity_charged_count_valid
    CHECK (charged_count >= 0)
);

ALTER TABLE app.workspace_artifact_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_artifact_capacity FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_artifact_capacity_owner_all
  ON app.workspace_artifact_capacity
  FOR ALL TO {{owner_role}}
  USING (true)
  WITH CHECK (true);

CREATE POLICY workspace_artifact_capacity_workspace_scope
  ON app.workspace_artifact_capacity
  FOR ALL TO {{api_runtime_role}},{{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

ALTER TABLE app.workspace_artifact_capacity OWNER TO {{owner_role}};
REVOKE ALL ON app.workspace_artifact_capacity
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
       {{lifecycle_command_role}},{{operator_role}};
GRANT SELECT ON app.workspace_artifact_capacity
  TO {{api_runtime_role}},{{worker_runtime_role}};
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER
  ON app.workspace_artifact_capacity TO {{owner_role}};

-- Existing metadata is authoritative for the initial charged totals. Deleted
-- rows represent completed metadata removal and are intentionally excluded.
INSERT INTO app.workspace_artifact_capacity
  (workspace_id,charged_bytes,charged_count)
SELECT workspace_id,coalesce(sum(byte_length),0),count(*)
  FROM app.artifacts
 WHERE status<>'deleted'
 GROUP BY workspace_id;
INSERT INTO app.workspace_artifact_capacity(workspace_id)
SELECT workspace.id
  FROM app.workspaces workspace
 WHERE NOT EXISTS (
   SELECT 1 FROM app.workspace_artifact_capacity capacity
    WHERE capacity.workspace_id=workspace.id
 );

CREATE FUNCTION app.artifact_capacity_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $function$
DECLARE
  v_workspace_id uuid:=coalesce(NEW.workspace_id,OLD.workspace_id);
  v_context text:=nullif(current_setting('app.workspace_id',true),'');
  v_capacity app.workspace_artifact_capacity%ROWTYPE;
  v_purge boolean:=false;
  v_release boolean:=false;
BEGIN
  v_purge:=app.workspace_purge_immutable_delete_is_armed(v_workspace_id);
  IF v_workspace_id IS NULL OR (NOT v_purge AND v_context IS NULL)
    OR (NOT v_purge AND v_context<>v_workspace_id::text) THEN
    RAISE EXCEPTION 'artifact capacity tenant context is required'
      USING ERRCODE='42501';
  END IF;

  IF TG_OP='UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.byte_length IS DISTINCT FROM OLD.byte_length
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
      OR NEW.media_type IS DISTINCT FROM OLD.media_type
      OR NEW.sha256 IS DISTINCT FROM OLD.sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'artifact immutable metadata cannot change'
        USING ERRCODE='P0002', DETAIL='artifact_metadata_immutable';
    END IF;
    IF OLD.status='deleted' AND NEW.status<>'deleted' THEN
      RAISE EXCEPTION 'deleted artifact cannot be revived'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
    IF NEW.status='deleted' AND OLD.status<>'deleted' THEN
      IF OLD.status<>'deleting' AND NOT v_purge THEN
        RAISE EXCEPTION 'artifact must be deleting before metadata deletion'
          USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
      END IF;
      v_release:=true;
    END IF;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.status='deleted' THEN
      RAISE EXCEPTION 'artifact cannot be created as deleted'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.status NOT IN ('deleting','deleted') AND NOT v_purge THEN
      RAISE EXCEPTION 'artifact deletion requires completed physical removal'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
    v_release:=OLD.status<>'deleted';
  END IF;

  INSERT INTO app.workspace_artifact_capacity(workspace_id)
  VALUES(v_workspace_id) ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO v_capacity
    FROM app.workspace_artifact_capacity
   WHERE workspace_id=v_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artifact capacity record is unavailable'
      USING ERRCODE='P0004', DETAIL='artifact_capacity_unavailable';
  END IF;

  IF TG_OP='INSERT' THEN
    IF v_capacity.charged_count+1>v_capacity.artifact_count_limit
      OR v_capacity.charged_bytes+NEW.byte_length>v_capacity.byte_limit THEN
      RAISE EXCEPTION 'workspace artifact capacity exceeded'
        USING ERRCODE='P0001', DETAIL='artifact_capacity_exceeded';
    END IF;
    UPDATE app.workspace_artifact_capacity
       SET charged_bytes=charged_bytes+NEW.byte_length,
           charged_count=charged_count+1,updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id;
  ELSIF v_release THEN
    IF v_capacity.charged_count<1
      OR v_capacity.charged_bytes<OLD.byte_length THEN
      RAISE EXCEPTION 'artifact capacity charge underflow'
        USING ERRCODE='P0004', DETAIL='artifact_capacity_underflow';
    END IF;
    UPDATE app.workspace_artifact_capacity
       SET charged_bytes=charged_bytes-OLD.byte_length,
           charged_count=charged_count-1,updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id;
  END IF;

  -- The tenant-row purge function predates this table and fail-closes on
  -- residual workspace-owned relations. Remove an empty capacity row as soon
  -- as the last charged artifact is dismantled under its fenced purge token.
  IF v_purge AND TG_OP IN ('DELETE','UPDATE')
    AND NOT EXISTS (
      SELECT 1 FROM app.artifacts artifact
       WHERE artifact.workspace_id=v_workspace_id
         AND artifact.id<>coalesce(OLD.id,NEW.id)
         AND artifact.status<>'deleted'
    ) THEN
    DELETE FROM app.workspace_artifact_capacity
     WHERE workspace_id=v_workspace_id;
  END IF;

  RETURN case when TG_OP='DELETE' then OLD else NEW end;
END;
$function$;

ALTER FUNCTION app.artifact_capacity_transition() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.artifact_capacity_transition()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
       {{lifecycle_command_role}},{{operator_role}};

CREATE TRIGGER artifacts_capacity_transition
  BEFORE INSERT OR DELETE OR UPDATE OF workspace_id,byte_length,purpose,
    storage_key,media_type,sha256,status,created_at ON app.artifacts
  FOR EACH ROW EXECUTE FUNCTION app.artifact_capacity_transition();

-- If a purge starts with no charged artifacts, remove the empty seeded row
-- before the legacy tenant-row residual check runs.
CREATE FUNCTION app.artifact_capacity_purge_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $function$
BEGIN
  IF NEW.status='purging' AND OLD.status IS DISTINCT FROM 'purging'
    AND NOT EXISTS (
      SELECT 1 FROM app.artifacts artifact
       WHERE artifact.workspace_id=NEW.id AND artifact.status<>'deleted'
    ) THEN
    DELETE FROM app.workspace_artifact_capacity
     WHERE workspace_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION app.artifact_capacity_purge_start() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.artifact_capacity_purge_start()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
       {{lifecycle_command_role}},{{operator_role}};
CREATE TRIGGER workspace_artifact_capacity_purge_start
  BEFORE UPDATE OF status ON app.workspaces
  FOR EACH ROW EXECUTE FUNCTION app.artifact_capacity_purge_start();
