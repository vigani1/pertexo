-- Only the reviewed maintenance function may remove expired preview identity
-- and its already-deleted artifact metadata. Runtime roles retain no direct
-- DELETE privilege on preview or artifact tables.

ALTER POLICY artifacts_workspace_scope ON app.artifacts
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}};

CREATE FUNCTION app.complete_preview_cleanup(
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
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
     NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'preview cleanup workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT expires_at
    INTO preview_expiry
    FROM app.preview_runs
   WHERE workspace_id = p_workspace_id
     AND id = p_preview_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF preview_expiry > clock_timestamp() THEN
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

-- Existing retained previews receive the same durable expiry wake-up as newly
-- accepted previews. UUID and trace strings need no JSON escaping beyond their
-- constrained formats, so this reproduces the application's lexical checksum.
-- The migration transaction temporarily removes FORCE for the owning role;
-- serving roles remain governed by RLS and the final state is restored before
-- commit.
ALTER TABLE app.preview_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events NO FORCE ROW LEVEL SECURITY;

WITH cleanup_events AS (
  SELECT preview.workspace_id,
         preview.id AS preview_run_id,
         preview.expires_at,
         preview.traceparent,
         gen_random_uuid() AS outbox_event_id
    FROM app.preview_runs preview
)
INSERT INTO app.outbox_events (
  id, workspace_id, job_name, schema_version, aggregate_type, aggregate_id,
  payload, payload_checksum, available_at
)
SELECT event.outbox_event_id,
       event.workspace_id,
       'sweep-expired-previews',
       1,
       'preview-run',
       event.preview_run_id,
       jsonb_strip_nulls(jsonb_build_object(
         'schemaVersion', 1,
         'workspaceId', event.workspace_id,
         'outboxEventId', event.outbox_event_id,
         'previewRunId', event.preview_run_id,
         'traceparent', event.traceparent
       )),
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         CASE WHEN event.traceparent IS NULL THEN
           '{"outboxEventId":"' || event.outbox_event_id::text ||
           '","previewRunId":"' || event.preview_run_id::text ||
           '","schemaVersion":1,"workspaceId":"' ||
           event.workspace_id::text || '"}'
         ELSE
           '{"outboxEventId":"' || event.outbox_event_id::text ||
           '","previewRunId":"' || event.preview_run_id::text ||
           '","schemaVersion":1,"traceparent":"' || event.traceparent ||
           '","workspaceId":"' || event.workspace_id::text || '"}'
         END,
         'UTF8'
       )), 'hex'),
       event.expires_at
  FROM cleanup_events event;

ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
