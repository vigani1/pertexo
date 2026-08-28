-- Restore-before-serve receives only a bounded, read-only inventory interface;
-- the maintenance role never receives direct tenant-table access.
CREATE FUNCTION app.enumerate_committed_tenant_artifacts(
  p_after_workspace_id uuid,
  p_after_artifact_id uuid,
  p_limit integer
) RETURNS TABLE(
  workspace_id uuid,
  artifact_id uuid,
  byte_length bigint,
  media_type varchar,
  sha256 text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 OR
     ((p_after_workspace_id IS NULL)<>(p_after_artifact_id IS NULL)) THEN
    RAISE EXCEPTION 'invalid restore artifact inventory cursor or bound'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT artifact.workspace_id,artifact.id,artifact.byte_length,
         artifact.media_type,artifact.sha256::text
    FROM app.artifacts artifact
   WHERE artifact.status='available'
     AND artifact.finalized_at IS NOT NULL
     AND artifact.deleted_at IS NULL
     AND (
       p_after_workspace_id IS NULL OR
       (artifact.workspace_id,artifact.id)>
         (p_after_workspace_id,p_after_artifact_id)
     )
   ORDER BY artifact.workspace_id,artifact.id
   LIMIT p_limit;
END $$;
ALTER FUNCTION app.enumerate_committed_tenant_artifacts(uuid,uuid,integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.enumerate_committed_tenant_artifacts(uuid,uuid,integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
       {{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.enumerate_committed_tenant_artifacts(uuid,uuid,integer)
  TO {{maintenance_role}};
