-- Only format-owned references are execution dependencies. Inline values are user JSON.
CREATE FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text)
RETURNS SETOF uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  WITH candidates AS (
    SELECT p_value AS reference WHERE p_format='value'
    UNION ALL
    -- Node file values carry the complete tagged descriptor; a user's artifactId alone is not one.
    SELECT reference FROM jsonb_path_query(p_value,'lax $.value.** ? (@.kind == "artifact" && exists(@.byteLength) && exists(@.mediaType) && exists(@.sha256))') reference
      WHERE p_format='value' AND p_value->>'kind'='inline'
    UNION ALL
    SELECT reference FROM jsonb_path_query(p_value,'lax $.invocations[*].output') reference WHERE p_format='checkpoint'
    UNION ALL
    SELECT reference FROM jsonb_path_query(p_value,'lax $.joins[*].ledger[*].output') reference WHERE p_format='checkpoint'
    UNION ALL
    SELECT reference FROM jsonb_path_query(p_value,'lax $.loops[*].collection') reference WHERE p_format='checkpoint'
    UNION ALL
    SELECT p_value->'output' WHERE p_format='event'
  )
  SELECT DISTINCT (reference->>'artifactId')::uuid FROM candidates
  WHERE reference->>'kind'='artifact' AND reference->>'artifactId' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.execution_artifact_ids(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.execution_artifact_ids(jsonb,text) TO {{app_role}}, {{maintenance_role}};
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lock_execution_artifact_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'pg_temp'
SET row_security TO 'on'
AS $$
DECLARE
  v_artifact_id uuid;
  v_row jsonb:=to_jsonb(NEW);
BEGIN
  FOR v_artifact_id IN
    SELECT DISTINCT id FROM (
      SELECT app.execution_artifact_ids(v_row->'input_ref','value') id
      UNION ALL SELECT app.execution_artifact_ids(v_row->'output_ref','value')
      UNION ALL SELECT app.execution_artifact_ids(v_row->'reconciliation_ref','value')
      UNION ALL SELECT app.execution_artifact_ids(v_row->'scheduler_state','checkpoint')
      UNION ALL SELECT app.execution_artifact_ids(v_row->'payload','event')
    ) candidates ORDER BY id
  LOOP
    PERFORM 1 FROM app.artifacts artifact
      WHERE artifact.workspace_id=NEW.workspace_id AND artifact.id=v_artifact_id
        AND artifact.status='available' AND artifact.deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'execution artifact reference is unavailable' USING ERRCODE='23503';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
