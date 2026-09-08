-- Finalization extends a short-lived pending upload into the standard
-- user-upload retention window. API and worker artifact writers therefore
-- need column-level authority for that deadline transition.

-- Artifacts are FORCE RLS protected. Iterate the global workspace inventory
-- and install the same transaction-local scope used by runtime writers so the
-- backfill cannot silently skip legacy rows.
DO $backfill$
DECLARE
  v_workspace_id uuid;
BEGIN
  FOR v_workspace_id IN SELECT id FROM app.workspaces ORDER BY id LOOP
    PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
    UPDATE app.artifacts
       SET expires_at=finalized_at+interval '30 days',
           updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id
       AND purpose='user-upload'
       AND status='available'
       AND finalized_at IS NOT NULL
       AND expires_at < finalized_at+interval '30 days';
  END LOOP;
  PERFORM set_config('app.workspace_id','',true);
END
$backfill$;

GRANT UPDATE (expires_at) ON app.artifacts
  TO {{api_runtime_role}}, {{worker_runtime_role}};
