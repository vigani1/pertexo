-- The privileged deletion boundary independently enforces terminal preview
-- truth. Runtime-role callers cannot bypass the adapter's lifecycle guard by
-- invoking the SECURITY DEFINER function directly.

CREATE OR REPLACE FUNCTION app.complete_preview_cleanup(
  p_workspace_id uuid,
  p_preview_run_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  preview_expiry timestamptz;
  preview_status varchar(32);
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
     NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'preview cleanup workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT expires_at, status
    INTO preview_expiry, preview_status
    FROM app.preview_runs
   WHERE workspace_id = p_workspace_id
     AND id = p_preview_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF preview_expiry > clock_timestamp() OR preview_status NOT IN (
    'succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM app.preview_runs
     WHERE workspace_id = p_workspace_id
       AND prior_preview_run_id = p_preview_run_id
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM app.artifact_links link
      JOIN app.artifacts artifact
        ON artifact.workspace_id = link.workspace_id
       AND artifact.id = link.artifact_id
     WHERE link.workspace_id = p_workspace_id
       AND link.owner_kind = 'preview_run'
       AND link.owner_id = p_preview_run_id
       AND artifact.status <> 'deleted'
  ) THEN
    RETURN false;
  END IF;

  WITH removed_links AS (
    DELETE FROM app.artifact_links
     WHERE workspace_id = p_workspace_id
       AND owner_kind = 'preview_run'
       AND owner_id = p_preview_run_id
    RETURNING artifact_id
  )
  DELETE FROM app.artifacts artifact
   USING removed_links
   WHERE artifact.workspace_id = p_workspace_id
     AND artifact.id = removed_links.artifact_id
     AND artifact.status = 'deleted';

  DELETE FROM app.preview_attempts
   WHERE workspace_id = p_workspace_id
     AND preview_run_id = p_preview_run_id;
  DELETE FROM app.idempotency_records
   WHERE workspace_id = p_workspace_id
     AND operation = 'preview.execute'
     AND resource_id = p_preview_run_id
     AND expires_at <= clock_timestamp();
  DELETE FROM app.preview_runs
   WHERE workspace_id = p_workspace_id
     AND id = p_preview_run_id;
  RETURN true;
END;
$function$;

ALTER FUNCTION app.complete_preview_cleanup(uuid, uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.complete_preview_cleanup(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_preview_cleanup(uuid, uuid)
  TO {{worker_runtime_role}};
