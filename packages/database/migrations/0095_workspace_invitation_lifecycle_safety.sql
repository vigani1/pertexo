-- Correct invitation lock ordering and add bounded transient cleanup (ADR 038).

CREATE TABLE app.workspace_invitation_binding_replacement_claims (
  prior_workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  prior_intent_id uuid NOT NULL,
  prior_binding_digest char(64) NOT NULL,
  successor_workspace_id uuid NOT NULL,
  successor_intent_id uuid NOT NULL,
  successor_invitation_id uuid NOT NULL,
  successor_invitation_revision integer NOT NULL,
  successor_binding_digest char(64) NOT NULL,
  successor_csrf_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (prior_workspace_id,prior_intent_id,prior_binding_digest),
  CHECK (
    prior_binding_digest ~ '^[0-9a-f]{64}$'
    AND successor_binding_digest ~ '^[0-9a-f]{64}$'
    AND successor_csrf_digest ~ '^[0-9a-f]{64}$'
  ),
  CHECK (successor_invitation_revision > 0)
);
CREATE INDEX workspace_invitation_binding_replacement_successor_idx
  ON app.workspace_invitation_binding_replacement_claims(
    successor_workspace_id,successor_intent_id,successor_binding_digest
  );
CREATE INDEX workspace_invitation_binding_replacement_cleanup_idx
  ON app.workspace_invitation_binding_replacement_claims(
    updated_at,prior_workspace_id,prior_intent_id
  );

ALTER TABLE app.workspace_invitation_binding_replacement_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_invitation_binding_replacement_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_invitation_binding_replacement_claims_workspace_scope
  ON app.workspace_invitation_binding_replacement_claims
  FOR ALL TO {{api_runtime_role}}
  USING (prior_workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (prior_workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_invitation_binding_replacement_claims_owner_maintenance
  ON app.workspace_invitation_binding_replacement_claims
  FOR ALL TO {{owner_role}} USING (true) WITH CHECK (true);
REVOKE ALL ON app.workspace_invitation_binding_replacement_claims
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT,INSERT,UPDATE ON app.workspace_invitation_binding_replacement_claims
  TO {{api_runtime_role}};
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER
  ON app.workspace_invitation_binding_replacement_claims
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

CREATE FUNCTION app.workspace_invitation_replacement_claim_is_reapable(
  p_prior_workspace_id uuid,p_prior_intent_id uuid,
  p_prior_binding_digest char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_binding_digests text[];
  v_unsafe boolean;
BEGIN
  WITH RECURSIVE lineage AS (
    SELECT claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest,claim.successor_workspace_id,
           claim.successor_intent_id,claim.successor_binding_digest,
           1 depth,
           ARRAY[(claim.prior_workspace_id::text||':'||claim.prior_intent_id::text||':'||claim.prior_binding_digest::text)] path,
           false cycle
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE claim.prior_workspace_id=p_prior_workspace_id
       AND claim.prior_intent_id=p_prior_intent_id
       AND claim.prior_binding_digest=p_prior_binding_digest
    UNION ALL
    SELECT next.prior_workspace_id,next.prior_intent_id,
           next.prior_binding_digest,next.successor_workspace_id,
           next.successor_intent_id,next.successor_binding_digest,
           lineage.depth+1,
           lineage.path||(next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text),
           (next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text)=ANY(lineage.path)
      FROM lineage
      JOIN app.workspace_invitation_binding_replacement_claims next
        ON next.prior_workspace_id=lineage.successor_workspace_id
       AND next.prior_intent_id=lineage.successor_intent_id
       AND next.prior_binding_digest=lineage.successor_binding_digest
     WHERE lineage.depth<32 AND NOT lineage.cycle
  ), binding_digests AS (
    SELECT prior_binding_digest::text binding_digest FROM lineage
    UNION
    SELECT successor_binding_digest::text FROM lineage
  )
  SELECT array_agg(binding_digest ORDER BY binding_digest)
    INTO v_binding_digests FROM binding_digests;
  IF v_binding_digests IS NULL THEN RETURN false; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(binding_digest,0))
    FROM unnest(v_binding_digests) binding_digest ORDER BY binding_digest;

  WITH RECURSIVE lineage AS (
    SELECT claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest,claim.successor_workspace_id,
           claim.successor_intent_id,claim.successor_binding_digest,
           1 depth,
           ARRAY[(claim.prior_workspace_id::text||':'||claim.prior_intent_id::text||':'||claim.prior_binding_digest::text)] path,
           false cycle
      FROM app.workspace_invitation_binding_replacement_claims claim
     WHERE claim.prior_workspace_id=p_prior_workspace_id
       AND claim.prior_intent_id=p_prior_intent_id
       AND claim.prior_binding_digest=p_prior_binding_digest
    UNION ALL
    SELECT next.prior_workspace_id,next.prior_intent_id,
           next.prior_binding_digest,next.successor_workspace_id,
           next.successor_intent_id,next.successor_binding_digest,
           lineage.depth+1,
           lineage.path||(next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text),
           (next.prior_workspace_id::text||':'||next.prior_intent_id::text||':'||next.prior_binding_digest::text)=ANY(lineage.path)
      FROM lineage
      JOIN app.workspace_invitation_binding_replacement_claims next
        ON next.prior_workspace_id=lineage.successor_workspace_id
       AND next.prior_intent_id=lineage.successor_intent_id
       AND next.prior_binding_digest=lineage.successor_binding_digest
     WHERE lineage.depth<32 AND NOT lineage.cycle
  )
  SELECT EXISTS (
    SELECT 1 FROM lineage WHERE cycle
    UNION ALL
    SELECT 1 FROM lineage tail
     WHERE tail.depth=32 AND EXISTS (
       SELECT 1 FROM app.workspace_invitation_binding_replacement_claims next
        WHERE next.prior_workspace_id=tail.successor_workspace_id
          AND next.prior_intent_id=tail.successor_intent_id
          AND next.prior_binding_digest=tail.successor_binding_digest)
    UNION ALL
    SELECT 1 FROM lineage
     JOIN app.workspace_invitation_acceptance_intents intent
       ON intent.workspace_id=lineage.successor_workspace_id
      AND intent.id=lineage.successor_intent_id
      AND intent.binding_digest=lineage.successor_binding_digest
     WHERE intent.status NOT IN ('abandoned','superseded')
       AND intent.expires_at>clock_timestamp()
    UNION ALL
    SELECT 1 FROM app.workspace_legal_holds hold
     WHERE hold.released_sequence IS NULL AND (
       hold.workspace_id=p_prior_workspace_id OR EXISTS (
         SELECT 1 FROM lineage
          WHERE lineage.successor_workspace_id=hold.workspace_id))
  ) INTO v_unsafe;
  RETURN NOT coalesce(v_unsafe,true);
END $$;
ALTER FUNCTION app.workspace_invitation_replacement_claim_is_reapable(uuid,uuid,char)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workspace_invitation_replacement_claim_is_reapable(uuid,uuid,char)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}},
    {{dispatcher_role}}, {{lifecycle_command_role}}, {{operator_role}},
    {{maintenance_role}};

-- Claims participate in tenant purge from either side, but only after the
-- complete descendant lineage is terminal. Live cross-workspace fences remain
-- as minimal opaque evidence and are removed by later transient cleanup.
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  v_definition:=replace(
    v_definition,
    E'  IF v_count=0 THEN\n    FOREACH v_table IN ARRAY v_tables LOOP',
    E'  IF v_count=0 THEN\n    WITH candidates AS MATERIALIZED (\n      SELECT claim.ctid,claim.prior_workspace_id,claim.prior_intent_id,\n             claim.prior_binding_digest\n        FROM app.workspace_invitation_binding_replacement_claims claim\n       WHERE claim.prior_workspace_id=v_workspace_id\n          OR claim.successor_workspace_id=v_workspace_id\n       ORDER BY claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id\n       LIMIT p_page_size\n    ), eligible AS (\n      SELECT candidate.ctid FROM candidates candidate\n       WHERE app.workspace_invitation_replacement_claim_is_reapable(\n         candidate.prior_workspace_id,candidate.prior_intent_id,\n         candidate.prior_binding_digest)\n    )\n    DELETE FROM app.workspace_invitation_binding_replacement_claims claim\n      USING eligible WHERE claim.ctid=eligible.ctid;\n    GET DIAGNOSTICS v_count=ROW_COUNT;\n    IF v_count>0 THEN v_surface:=''workspace_invitation_binding_replacement_claims''; END IF;\n  END IF;\n\n  IF v_count=0 THEN\n    FOREACH v_table IN ARRAY v_tables LOOP'
  );
  IF position('workspace_invitation_binding_replacement_claims' in v_definition)=0 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible with invitation claims';
  END IF;
  EXECUTE v_definition;
END $$;

CREATE OR REPLACE FUNCTION app.apply_workspace_invitation_deletion_side_effects()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_prior_workspace text;
BEGIN
  IF NEW.status<>'pending_deletion' THEN RETURN NEW; END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  -- The workspace row is already locked by the triggering update. Keep the
  -- remaining order invitation -> delivery attempt -> acceptance intent.
  UPDATE app.workspace_invitations
    SET status='revoked',revision=revision+1,revoked_at=clock_timestamp(),
        delivery_status='canceled',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status='pending';
  UPDATE app.workspace_invitation_delivery_attempts
    SET status=CASE WHEN status IN ('queued','failed') THEN 'canceled' ELSE status END,
        token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,
        token_key_version=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status IN ('queued','failed','unknown');
  UPDATE app.workspace_invitation_acceptance_intents
    SET status='superseded',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status IN ('pending','verified','wrong_account');
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION app.apply_workspace_invitation_deletion_side_effects() FROM PUBLIC;

CREATE FUNCTION app.reap_workspace_invitation_transients(p_limit integer DEFAULT 100)
RETURNS TABLE(invitations_expired integer, acceptance_intents_deleted integer,
  replacement_claims_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_candidate record;
  v_expired integer := 0;
  v_deleted integer := 0;
  v_claims_deleted integer := 0;
  v_row_count integer := 0;
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

  FOR v_candidate IN
    SELECT claim.prior_workspace_id,claim.prior_intent_id,
           claim.prior_binding_digest
      FROM app.workspace_invitation_binding_replacement_claims claim
     ORDER BY claim.updated_at,claim.prior_workspace_id,claim.prior_intent_id
     LIMIT p_limit
  LOOP
    IF app.workspace_invitation_replacement_claim_is_reapable(
      v_candidate.prior_workspace_id,v_candidate.prior_intent_id,
      v_candidate.prior_binding_digest
    ) THEN
      DELETE FROM app.workspace_invitation_binding_replacement_claims
       WHERE prior_workspace_id=v_candidate.prior_workspace_id
         AND prior_intent_id=v_candidate.prior_intent_id
         AND prior_binding_digest=v_candidate.prior_binding_digest;
      GET DIAGNOSTICS v_row_count=ROW_COUNT;
      v_claims_deleted:=v_claims_deleted+v_row_count;
    END IF;
  END LOOP;

  invitations_expired:=v_expired;
  acceptance_intents_deleted:=v_deleted;
  replacement_claims_deleted:=v_claims_deleted;
  RETURN NEXT;
END $$;
ALTER FUNCTION app.reap_workspace_invitation_transients(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.reap_workspace_invitation_transients(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}},
    {{dispatcher_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.reap_workspace_invitation_transients(integer)
  TO {{maintenance_role}};
