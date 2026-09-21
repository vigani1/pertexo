-- Forward-only repair for workspace-purge invitation-claim scan restarts.
-- Migrations 0095 and 0096 are already shared and remain immutable.

CREATE OR REPLACE FUNCTION app.scan_workspace_invitation_replacement_claims(
  p_scan_kind varchar,p_scan_id uuid,p_workspace_id uuid,p_limit integer
) RETURNS TABLE(deleted_count integer,scanned_count integer,cycle_completed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_state app.workspace_invitation_claim_cleanup_cursors%ROWTYPE;
  v_candidate record;
  v_deleted integer:=0;
  v_scanned integer:=0;
  v_cycle_completed boolean:=false;
  v_last_updated_at timestamptz;
  v_last_workspace_id uuid;
  v_last_intent_id uuid;
  v_last_binding_digest char(64);
  v_next_high_water_updated_at timestamptz;
  v_next_high_water_workspace_id uuid;
  v_next_high_water_intent_id uuid;
  v_next_high_water_binding_digest char(64);
BEGIN
  IF p_scan_kind NOT IN ('transient','workspace_purge')
    OR p_scan_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
    OR (p_scan_kind='transient' AND (
      p_scan_id<>'00000000-0000-0000-0000-000000000000'::uuid
      OR p_workspace_id IS NOT NULL))
    OR (p_scan_kind='workspace_purge' AND p_workspace_id IS NULL) THEN
    RAISE EXCEPTION 'invalid invitation replacement claim scan'
      USING ERRCODE='22023';
  END IF;

  INSERT INTO app.workspace_invitation_claim_cleanup_cursors
    (scan_kind,scan_id,workspace_id,purge_job_id)
  VALUES(
    p_scan_kind,p_scan_id,p_workspace_id,
    CASE WHEN p_scan_kind='workspace_purge' THEN p_scan_id ELSE NULL END)
  ON CONFLICT(scan_kind,scan_id) DO NOTHING;

  SELECT * INTO STRICT v_state
    FROM app.workspace_invitation_claim_cleanup_cursors
   WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id FOR UPDATE;
  IF v_state.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'invitation replacement claim scan scope changed'
      USING ERRCODE='22023';
  END IF;

  IF v_state.cycle_completed THEN
    IF p_scan_kind='transient' THEN
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cursor_updated_at=NULL,cursor_prior_workspace_id=NULL,
             cursor_prior_intent_id=NULL,cursor_prior_binding_digest=NULL,
             high_water_updated_at=NULL,high_water_prior_workspace_id=NULL,
             high_water_prior_intent_id=NULL,high_water_prior_binding_digest=NULL,
             cycle_completed=false,updated_at=clock_timestamp()
       WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id
       RETURNING * INTO v_state;
    ELSE
      SELECT claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
             claim.prior_binding_digest
        INTO v_next_high_water_updated_at,v_next_high_water_workspace_id,
             v_next_high_water_intent_id,v_next_high_water_binding_digest
        FROM app.workspace_invitation_binding_replacement_claims claim
       WHERE (claim.prior_workspace_id=p_workspace_id
          OR claim.successor_workspace_id=p_workspace_id)
         AND (v_state.high_water_updated_at IS NULL OR
           (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
            claim.prior_binding_digest)>
           (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
            v_state.high_water_prior_intent_id,
            v_state.high_water_prior_binding_digest))
       ORDER BY claim.updated_at DESC,claim.prior_workspace_id DESC,
                claim.prior_intent_id DESC,claim.prior_binding_digest DESC
       LIMIT 1;
      IF v_next_high_water_updated_at IS NULL THEN
        RETURN QUERY SELECT 0,0,true;
        RETURN;
      END IF;
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cursor_updated_at=v_state.high_water_updated_at,
             cursor_prior_workspace_id=v_state.high_water_prior_workspace_id,
             cursor_prior_intent_id=v_state.high_water_prior_intent_id,
             cursor_prior_binding_digest=v_state.high_water_prior_binding_digest,
             high_water_updated_at=v_next_high_water_updated_at,
             high_water_prior_workspace_id=v_next_high_water_workspace_id,
             high_water_prior_intent_id=v_next_high_water_intent_id,
             high_water_prior_binding_digest=v_next_high_water_binding_digest,
             cycle_completed=false,updated_at=clock_timestamp()
       WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id
       RETURNING * INTO v_state;
    END IF;
  END IF;

  IF v_state.high_water_updated_at IS NULL THEN
    SELECT claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest
      INTO v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
           v_state.high_water_prior_intent_id,
           v_state.high_water_prior_binding_digest
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE p_scan_kind='transient'
        OR claim.prior_workspace_id=p_workspace_id
        OR claim.successor_workspace_id=p_workspace_id
     ORDER BY claim.updated_at DESC,claim.prior_workspace_id DESC,
              claim.prior_intent_id DESC,claim.prior_binding_digest DESC
     LIMIT 1;
    IF v_state.high_water_updated_at IS NULL THEN
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cycle_completed=true,updated_at=clock_timestamp()
       WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id;
      RETURN QUERY SELECT 0,0,true;
      RETURN;
    END IF;
    UPDATE app.workspace_invitation_claim_cleanup_cursors
       SET high_water_updated_at=v_state.high_water_updated_at,
           high_water_prior_workspace_id=v_state.high_water_prior_workspace_id,
           high_water_prior_intent_id=v_state.high_water_prior_intent_id,
           high_water_prior_binding_digest=v_state.high_water_prior_binding_digest,
           updated_at=clock_timestamp()
     WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id;
  END IF;

  FOR v_candidate IN
    SELECT claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE (p_scan_kind='transient'
        OR claim.prior_workspace_id=p_workspace_id
        OR claim.successor_workspace_id=p_workspace_id)
       AND (v_state.cursor_updated_at IS NULL OR
         (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
          claim.prior_binding_digest)>
         (v_state.cursor_updated_at,v_state.cursor_prior_workspace_id,
          v_state.cursor_prior_intent_id,v_state.cursor_prior_binding_digest))
       AND (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
            claim.prior_binding_digest)<=
           (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
            v_state.high_water_prior_intent_id,
            v_state.high_water_prior_binding_digest)
     ORDER BY claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
              claim.prior_binding_digest
     LIMIT p_limit
  LOOP
    v_scanned:=v_scanned+1;
    v_last_updated_at:=v_candidate.updated_at;
    v_last_workspace_id:=v_candidate.prior_workspace_id;
    v_last_intent_id:=v_candidate.prior_intent_id;
    v_last_binding_digest:=v_candidate.prior_binding_digest;
    IF app.workspace_invitation_replacement_claim_is_reapable(
      v_candidate.prior_workspace_id,v_candidate.prior_intent_id,
      v_candidate.prior_binding_digest
    ) THEN
      DELETE FROM app.workspace_invitation_binding_replacement_claims
       WHERE prior_workspace_id=v_candidate.prior_workspace_id
         AND prior_intent_id=v_candidate.prior_intent_id
         AND prior_binding_digest=v_candidate.prior_binding_digest;
      IF FOUND THEN v_deleted:=v_deleted+1; END IF;
    END IF;
  END LOOP;

  v_cycle_completed:=v_scanned=0 OR
    (v_last_updated_at,v_last_workspace_id,v_last_intent_id,v_last_binding_digest)>=
    (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
     v_state.high_water_prior_intent_id,v_state.high_water_prior_binding_digest);
  UPDATE app.workspace_invitation_claim_cleanup_cursors
     SET cursor_updated_at=coalesce(v_last_updated_at,cursor_updated_at),
         cursor_prior_workspace_id=coalesce(v_last_workspace_id,cursor_prior_workspace_id),
         cursor_prior_intent_id=coalesce(v_last_intent_id,cursor_prior_intent_id),
         cursor_prior_binding_digest=coalesce(v_last_binding_digest,cursor_prior_binding_digest),
         cycle_completed=v_cycle_completed,updated_at=clock_timestamp()
   WHERE scan_kind=p_scan_kind AND scan_id=p_scan_id;
  RETURN QUERY SELECT v_deleted,v_scanned,v_cycle_completed;
END $$;
