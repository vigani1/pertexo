-- Forward-only repair for bounded invitation replacement-claim scan progress.
-- Migration 0095 is already shared and remains immutable.

CREATE TABLE app.workspace_invitation_claim_cleanup_cursors (
  scan_kind varchar(32) NOT NULL,
  scan_id uuid NOT NULL,
  workspace_id uuid,
  purge_job_id uuid REFERENCES app.workspace_purge_jobs(id) ON DELETE CASCADE,
  cursor_updated_at timestamptz,
  cursor_prior_workspace_id uuid,
  cursor_prior_intent_id uuid,
  cursor_prior_binding_digest char(64),
  high_water_updated_at timestamptz,
  high_water_prior_workspace_id uuid,
  high_water_prior_intent_id uuid,
  high_water_prior_binding_digest char(64),
  cycle_completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scan_kind,scan_id),
  CONSTRAINT workspace_invitation_claim_cleanup_cursor_scope_valid CHECK (
    (scan_kind='transient'
      AND scan_id='00000000-0000-0000-0000-000000000000'::uuid
      AND workspace_id IS NULL AND purge_job_id IS NULL)
    OR
    (scan_kind='workspace_purge' AND scan_id=purge_job_id
      AND workspace_id IS NOT NULL AND purge_job_id IS NOT NULL)
  ),
  CONSTRAINT workspace_invitation_claim_cleanup_cursor_position_valid CHECK (
    (cursor_updated_at IS NULL AND cursor_prior_workspace_id IS NULL
      AND cursor_prior_intent_id IS NULL AND cursor_prior_binding_digest IS NULL)
    OR
    (cursor_updated_at IS NOT NULL AND cursor_prior_workspace_id IS NOT NULL
      AND cursor_prior_intent_id IS NOT NULL
      AND cursor_prior_binding_digest~'^[0-9a-f]{64}$')
  ),
  CONSTRAINT workspace_invitation_claim_cleanup_high_water_valid CHECK (
    (high_water_updated_at IS NULL AND high_water_prior_workspace_id IS NULL
      AND high_water_prior_intent_id IS NULL
      AND high_water_prior_binding_digest IS NULL)
    OR
    (high_water_updated_at IS NOT NULL
      AND high_water_prior_workspace_id IS NOT NULL
      AND high_water_prior_intent_id IS NOT NULL
      AND high_water_prior_binding_digest~'^[0-9a-f]{64}$')
  ),
  CONSTRAINT workspace_invitation_claim_cleanup_bounds_valid CHECK (
    cursor_updated_at IS NULL OR high_water_updated_at IS NOT NULL
  )
);
ALTER TABLE app.workspace_invitation_claim_cleanup_cursors OWNER TO {{owner_role}};
REVOKE ALL ON app.workspace_invitation_claim_cleanup_cursors
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{lifecycle_command_role}},{{operator_role}};
INSERT INTO app.workspace_invitation_claim_cleanup_cursors(scan_kind,scan_id)
VALUES('transient','00000000-0000-0000-0000-000000000000');

CREATE FUNCTION app.scan_workspace_invitation_replacement_claims(
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
    ELSIF NOT EXISTS (
      SELECT 1 FROM app.workspace_invitation_binding_replacement_claims claim
       WHERE (claim.prior_workspace_id=p_workspace_id
          OR claim.successor_workspace_id=p_workspace_id)
         AND (claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id,
              claim.prior_binding_digest)>
             (v_state.high_water_updated_at,v_state.high_water_prior_workspace_id,
              v_state.high_water_prior_intent_id,
              v_state.high_water_prior_binding_digest)
    ) THEN
      RETURN QUERY SELECT 0,0,true;
      RETURN;
    ELSE
      UPDATE app.workspace_invitation_claim_cleanup_cursors
         SET cursor_updated_at=high_water_updated_at,
             cursor_prior_workspace_id=high_water_prior_workspace_id,
             cursor_prior_intent_id=high_water_prior_intent_id,
             cursor_prior_binding_digest=high_water_prior_binding_digest,
             high_water_updated_at=NULL,high_water_prior_workspace_id=NULL,
             high_water_prior_intent_id=NULL,high_water_prior_binding_digest=NULL,
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
ALTER FUNCTION app.scan_workspace_invitation_replacement_claims(varchar,uuid,uuid,integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION
  app.scan_workspace_invitation_replacement_claims(varchar,uuid,uuid,integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{lifecycle_command_role}},{{operator_role}};

-- Replace only the invitation-claim block introduced by migration 0095 and
-- preserve every earlier tenant-purge repair.
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  v_definition:=replace(v_definition,E'  v_table text;\n',
    E'  v_table text;\n  v_invitation_claim_scan record;\n');
  v_definition:=replace(
    v_definition,
    E'    ''transport_security_audit_facts''\n  ];',
    E'    ''transport_security_audit_facts'',\n    ''workspace_invitation_claim_cleanup_cursors''\n  ];'
  );
  v_definition:=replace(
    v_definition,
    E'  IF v_count=0 THEN\n    WITH candidates AS MATERIALIZED (\n      SELECT claim.ctid,claim.prior_workspace_id,claim.prior_intent_id,\n             claim.prior_binding_digest\n        FROM app.workspace_invitation_binding_replacement_claims claim\n       WHERE claim.prior_workspace_id=v_workspace_id\n          OR claim.successor_workspace_id=v_workspace_id\n       ORDER BY claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id\n       LIMIT p_page_size\n    ), eligible AS (\n      SELECT candidate.ctid FROM candidates candidate\n       WHERE app.workspace_invitation_replacement_claim_is_reapable(\n         candidate.prior_workspace_id,candidate.prior_intent_id,\n         candidate.prior_binding_digest)\n    )\n    DELETE FROM app.workspace_invitation_binding_replacement_claims claim\n      USING eligible WHERE claim.ctid=eligible.ctid;\n    GET DIAGNOSTICS v_count=ROW_COUNT;\n    IF v_count>0 THEN v_surface:=''workspace_invitation_binding_replacement_claims''; END IF;\n  END IF;\n',
    E'  IF v_count=0 THEN\n    SELECT * INTO v_invitation_claim_scan\n      FROM app.scan_workspace_invitation_replacement_claims(\n        ''workspace_purge'',p_job_id,v_workspace_id,p_page_size);\n    v_count:=v_invitation_claim_scan.deleted_count;\n    IF v_count>0 THEN\n      v_surface:=''workspace_invitation_binding_replacement_claims'';\n    ELSIF v_invitation_claim_scan.scanned_count>0\n      AND NOT v_invitation_claim_scan.cycle_completed THEN\n      PERFORM set_config(''app.workspace_purge_transition'',''on'',true);\n      UPDATE app.workspace_purge_steps SET status=''pending'',lease_owner=NULL,\n        lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,\n        updated_at=clock_timestamp()\n        WHERE job_id=p_job_id AND step_name=''tenant_rows'';\n      RETURN QUERY SELECT ''workspace_invitation_binding_replacement_claim_scan''::varchar,\n        v_invitation_claim_scan.scanned_count,false;\n      RETURN;\n    END IF;\n  END IF;\n'
  );
  v_definition:=replace(
    v_definition,
    E'  UPDATE app.workspace_purge_steps SET status=''completed'',lease_owner=NULL,lease_token=NULL,',
    E'  DELETE FROM app.workspace_invitation_claim_cleanup_cursors\n    WHERE scan_kind=''workspace_purge'' AND scan_id=p_job_id;\n  UPDATE app.workspace_purge_steps SET status=''completed'',lease_owner=NULL,lease_token=NULL,'
  );
  IF position('v_invitation_claim_scan record' in v_definition)=0
    OR position('workspace_invitation_binding_replacement_claim_scan' in v_definition)=0
    OR position('DELETE FROM app.workspace_invitation_claim_cleanup_cursors' in v_definition)=0 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible with claim progress repair';
  END IF;
  EXECUTE v_definition;
END $$;

CREATE OR REPLACE FUNCTION app.reap_workspace_invitation_transients(p_limit integer DEFAULT 100)
RETURNS TABLE(invitations_expired integer, acceptance_intents_deleted integer,
  replacement_claims_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_candidate record;
  v_claim_scan record;
  v_expired integer:=0;
  v_deleted integer:=0;
  v_claims_deleted integer:=0;
  v_row_count integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invitation transient cleanup limit must be between 1 and 1000'
      USING ERRCODE='22023';
  END IF;

  FOR v_candidate IN
    SELECT invitation.workspace_id,invitation.id
      FROM app.workspace_invitations invitation
     WHERE invitation.status='pending' AND invitation.expires_at<=clock_timestamp()
     ORDER BY invitation.expires_at,invitation.id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM app.workspaces WHERE id=v_candidate.workspace_id FOR UPDATE;
    PERFORM 1 FROM app.workspace_invitations
      WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.id FOR UPDATE;
    UPDATE app.workspace_invitations
       SET status='expired',delivery_status='canceled',updated_at=clock_timestamp()
     WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.id
       AND status='pending' AND expires_at<=clock_timestamp();
    IF FOUND THEN
      v_expired:=v_expired+1;
      UPDATE app.workspace_invitation_delivery_attempts
         SET status=CASE WHEN status IN ('queued','failed') THEN 'canceled' ELSE status END,
             token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,
             token_key_version=NULL,updated_at=clock_timestamp()
       WHERE workspace_id=v_candidate.workspace_id
         AND invitation_id=v_candidate.id
         AND status IN ('queued','failed','unknown');
      UPDATE app.workspace_invitation_acceptance_intents
         SET status='superseded',updated_at=clock_timestamp()
       WHERE workspace_id=v_candidate.workspace_id
         AND invitation_id=v_candidate.id
         AND status IN ('pending','verified','wrong_account');
    END IF;
  END LOOP;

  FOR v_candidate IN
    SELECT intent.workspace_id,intent.invitation_id,intent.id
      FROM app.workspace_invitation_acceptance_intents intent
     WHERE (intent.expires_at<=clock_timestamp() OR intent.status='abandoned')
       AND NOT EXISTS (
         SELECT 1 FROM app.workspace_legal_holds hold
          WHERE hold.workspace_id=intent.workspace_id
            AND hold.released_sequence IS NULL
       )
     ORDER BY intent.expires_at,intent.id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM app.workspaces WHERE id=v_candidate.workspace_id FOR UPDATE;
    PERFORM 1 FROM app.workspace_invitations
      WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.invitation_id FOR UPDATE;
    DELETE FROM app.workspace_invitation_acceptance_intents
     WHERE workspace_id=v_candidate.workspace_id AND id=v_candidate.id
       AND (expires_at<=clock_timestamp() OR status='abandoned');
    GET DIAGNOSTICS v_row_count=ROW_COUNT;
    v_deleted:=v_deleted+v_row_count;
  END LOOP;

  SELECT * INTO v_claim_scan
    FROM app.scan_workspace_invitation_replacement_claims(
      'transient','00000000-0000-0000-0000-000000000000'::uuid,NULL,p_limit);
  v_claims_deleted:=v_claim_scan.deleted_count;

  invitations_expired:=v_expired;
  acceptance_intents_deleted:=v_deleted;
  replacement_claims_deleted:=v_claims_deleted;
  RETURN NEXT;
END $$;
ALTER FUNCTION app.reap_workspace_invitation_transients(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.reap_workspace_invitation_transients(integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}},{{operator_role}};
GRANT EXECUTE ON FUNCTION app.reap_workspace_invitation_transients(integer)
  TO {{maintenance_role}};
