-- Nothing places legal holds any more (ADR 069), so the hold table goes with
-- its last two checks: invitation replacement-claim cleanup and inbox thread
-- expiry no longer look for an active hold.

CREATE OR REPLACE FUNCTION app.workspace_invitation_replacement_claim_is_reapable(p_prior_workspace_id uuid, p_prior_intent_id uuid, p_prior_binding_digest character)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
 SET row_security TO 'on'
AS $function$
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
  ) INTO v_unsafe;
  RETURN NOT coalesce(v_unsafe,true);
END $function$;

CREATE OR REPLACE FUNCTION app.expire_workspace_inbox_threads(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
 SET row_security TO 'on'
AS $function$
DECLARE v_removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox expiry limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  WITH expired AS MATERIALIZED (
    SELECT thread.workspace_id,thread.workflow_id
      FROM app.workspace_inbox_threads thread
     WHERE thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
     ORDER BY thread.latest_occurred_at,thread.workspace_id,thread.workflow_id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.workspace_inbox_threads thread USING expired
   WHERE thread.workspace_id=expired.workspace_id
     AND thread.workflow_id=expired.workflow_id;
  GET DIAGNOSTICS v_removed=ROW_COUNT;
  RETURN v_removed;
END $function$;

DROP TABLE app.workspace_legal_holds;
DROP FUNCTION app.reject_workspace_legal_hold_mutation();
