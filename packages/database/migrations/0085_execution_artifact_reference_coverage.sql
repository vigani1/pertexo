-- Events and checkpoints retain references outside the current engine's named fields.
-- An inline value owns arbitrary user JSON; only complete node file descriptors
-- inside it are dependencies, matching core's artifact reference collector.
CREATE OR REPLACE FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text)
RETURNS SETOF uuid LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  WITH RECURSIVE values_to_check(reference, user_json) AS (
    SELECT p_value, false WHERE p_format IN ('value','checkpoint','event')
    UNION ALL
    SELECT child.value,
      parent.user_json OR p_format='value' OR coalesce(parent.reference->>'kind'='inline',false)
    FROM values_to_check parent
    CROSS JOIN LATERAL (
      SELECT value FROM jsonb_each(
        CASE WHEN jsonb_typeof(parent.reference)='object' THEN parent.reference ELSE '{}'::jsonb END)
      UNION ALL
      SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(parent.reference)='array' THEN parent.reference ELSE '[]'::jsonb END)
    ) child
  )
  SELECT DISTINCT (reference->>'artifactId')::uuid FROM values_to_check
  WHERE reference->>'kind'='artifact'
    AND (NOT user_json OR reference ?& ARRAY['byteLength','mediaType','sha256'])
    AND reference->>'artifactId' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lock_execution_artifact_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app', 'pg_temp'
SET row_security TO 'on'
AS $$
DECLARE
  v_artifact_id uuid;
  v_row jsonb;
BEGIN
  -- Summary-only history has no dependencies. Avoid planning five extraction
  -- queries (and serializing the whole row) for every retained-history insert.
  IF TG_TABLE_NAME='workflow_runs' THEN
    IF NEW.input_ref IS NULL AND NEW.output_ref IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  v_row:=to_jsonb(NEW);
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
