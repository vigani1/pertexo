-- Durable identity-scoped authentication mail (ADR 040). This queue is
-- deliberately separate from tenant outbox/RLS state.

CREATE TABLE app.authentication_mail_deliveries (
  id uuid PRIMARY KEY,
  purpose varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner varchar(128),
  lease_token uuid,
  lease_generation bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  payload_ciphertext text,
  payload_nonce varchar(128),
  payload_tag varchar(256),
  payload_key_version varchar(64),
  provider_reference varchar(512),
  failure_code varchar(128),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT authentication_mail_purpose_valid CHECK (
    purpose IN ('verification','password_reset','email_change_confirmation')
  ),
  CONSTRAINT authentication_mail_status_valid CHECK (
    status IN ('queued','outcome_unknown','retry','submitted','failed',
               'reconciliation_required','expired')
  ),
  CONSTRAINT authentication_mail_attempts_bounded CHECK (
    attempt_count BETWEEN 0 AND 12
  ),
  CONSTRAINT authentication_mail_expiry_after_creation CHECK (
    expires_at > created_at
  ),
  CONSTRAINT authentication_mail_lease_complete CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT authentication_mail_payload_complete CHECK (
    (payload_ciphertext IS NULL AND payload_nonce IS NULL
      AND payload_tag IS NULL AND payload_key_version IS NULL)
    OR
    (payload_ciphertext IS NOT NULL AND payload_nonce IS NOT NULL
      AND payload_tag IS NOT NULL AND payload_key_version IS NOT NULL)
  ),
  CONSTRAINT authentication_mail_active_has_payload CHECK (
    status NOT IN ('queued','outcome_unknown','retry')
    OR payload_ciphertext IS NOT NULL
  )
);

CREATE INDEX authentication_mail_due_idx
  ON app.authentication_mail_deliveries(next_attempt_at,id)
  WHERE status IN ('queued','outcome_unknown','retry');
CREATE INDEX authentication_mail_retention_idx
  ON app.authentication_mail_deliveries(completed_at,id)
  WHERE status IN ('submitted','failed','reconciliation_required','expired');

REVOKE ALL ON app.authentication_mail_deliveries
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};

CREATE FUNCTION app.enqueue_authentication_mail(
  p_id uuid,
  p_purpose text,
  p_expires_at timestamptz,
  p_ciphertext text,
  p_nonce text,
  p_tag text,
  p_key_version text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
BEGIN
  IF p_id IS NULL OR p_purpose NOT IN
       ('verification','password_reset','email_change_confirmation')
     OR p_expires_at<=clock_timestamp()
     OR p_expires_at>clock_timestamp()+interval '7 days'
     OR length(p_ciphertext) NOT BETWEEN 1 AND 32768
     OR length(p_nonce) NOT BETWEEN 1 AND 128
     OR length(p_tag) NOT BETWEEN 1 AND 256
     OR p_key_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid authentication mail command' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.authentication_mail_deliveries(
    id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,
    payload_key_version
  ) VALUES (
    p_id,p_purpose,p_expires_at,p_ciphertext,p_nonce,p_tag,p_key_version
  );
END;
$$;

CREATE FUNCTION app.claim_authentication_mail(
  p_worker_id text,
  p_limit integer,
  p_lease_token uuid
) RETURNS TABLE(
  id uuid,purpose text,expires_at timestamptz,attempt_count integer,
  lease_generation bigint,payload_ciphertext text,payload_nonce text,
  payload_tag text,payload_key_version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid authentication mail claim' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
      FROM app.authentication_mail_deliveries delivery
     WHERE delivery.status IN ('queued','outcome_unknown','retry')
       AND delivery.expires_at>clock_timestamp()
       AND delivery.created_at+interval '24 hours'>clock_timestamp()
       AND delivery.next_attempt_at<=clock_timestamp()
       AND (delivery.lease_expires_at IS NULL
            OR delivery.lease_expires_at<=clock_timestamp())
       AND delivery.attempt_count<12
     ORDER BY delivery.next_attempt_at,delivery.id
     LIMIT p_limit
     FOR UPDATE OF delivery SKIP LOCKED
  ), claimed AS (
    UPDATE app.authentication_mail_deliveries delivery
       SET status='outcome_unknown',lease_owner=p_worker_id,
           lease_token=p_lease_token,
           lease_generation=delivery.lease_generation+1,
           lease_expires_at=clock_timestamp()+interval '60 seconds',
           attempt_count=delivery.attempt_count+1,
           updated_at=clock_timestamp()
      FROM candidates WHERE delivery.id=candidates.id
    RETURNING delivery.*
  )
  SELECT claimed.id,claimed.purpose::text,claimed.expires_at,
         claimed.attempt_count,claimed.lease_generation,
         claimed.payload_ciphertext,claimed.payload_nonce::text,
         claimed.payload_tag::text,claimed.payload_key_version::text
    FROM claimed ORDER BY claimed.next_attempt_at,claimed.id;
END;
$$;

CREATE FUNCTION app.settle_authentication_mail(
  p_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_outcome text,
  p_provider_reference text DEFAULT NULL,
  p_failure_code text DEFAULT NULL,
  p_retry_at timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
DECLARE v_changed integer;
BEGIN
  IF p_outcome NOT IN ('submitted','failed','retry','reconciliation_required')
     OR (p_outcome='retry' AND p_retry_at IS NULL) THEN
    RAISE EXCEPTION 'invalid authentication mail settlement' USING ERRCODE='22023';
  END IF;
  UPDATE app.authentication_mail_deliveries delivery
     SET status=CASE
           WHEN p_outcome='retry' AND
                (delivery.attempt_count>=12 OR p_retry_at>=delivery.expires_at
                 OR p_retry_at>=delivery.created_at+interval '24 hours')
             THEN 'reconciliation_required'
           ELSE p_outcome
         END,
         next_attempt_at=CASE WHEN p_outcome='retry' THEN p_retry_at
                              ELSE delivery.next_attempt_at END,
         provider_reference=left(p_provider_reference,512),
         failure_code=left(p_failure_code,128),
         payload_ciphertext=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_ciphertext ELSE NULL END,
         payload_nonce=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_nonce ELSE NULL END,
         payload_tag=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_tag ELSE NULL END,
         payload_key_version=CASE
           WHEN p_outcome='retry' AND delivery.attempt_count<12
                AND p_retry_at<delivery.expires_at
                AND p_retry_at<delivery.created_at+interval '24 hours'
             THEN delivery.payload_key_version ELSE NULL END,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
         completed_at=CASE WHEN p_outcome='retry' AND delivery.attempt_count<12
                                AND p_retry_at<delivery.expires_at
                                AND p_retry_at<delivery.created_at+interval '24 hours'
                           THEN NULL ELSE clock_timestamp() END,
         updated_at=clock_timestamp()
   WHERE delivery.id=p_id AND delivery.status='outcome_unknown'
     AND delivery.lease_token=p_lease_token
     AND delivery.lease_generation=p_lease_generation;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END;
$$;

CREATE FUNCTION app.prune_authentication_mail(p_limit integer)
RETURNS TABLE(expired integer,deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
DECLARE v_expired integer; v_deleted integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid authentication mail prune limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.authentication_mail_deliveries
     WHERE status IN ('queued','outcome_unknown','retry')
       AND (expires_at<=clock_timestamp()
            OR created_at+interval '24 hours'<=clock_timestamp()
            OR attempt_count>=12)
       AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
     ORDER BY created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE app.authentication_mail_deliveries delivery
     SET status=CASE WHEN delivery.expires_at<=clock_timestamp()
                     THEN 'expired' ELSE 'reconciliation_required' END,
         payload_ciphertext=NULL,payload_nonce=NULL,
         payload_tag=NULL,payload_key_version=NULL,lease_owner=NULL,
         lease_token=NULL,lease_expires_at=NULL,
         completed_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM candidates WHERE delivery.id=candidates.id;
  GET DIAGNOSTICS v_expired=ROW_COUNT;
  WITH candidates AS (
    SELECT id FROM app.authentication_mail_deliveries
     WHERE status IN ('submitted','failed','reconciliation_required','expired')
       AND completed_at<=clock_timestamp()-interval '30 days'
     ORDER BY completed_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.authentication_mail_deliveries delivery
   USING candidates WHERE delivery.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN QUERY SELECT v_expired,v_deleted;
END;
$$;

ALTER FUNCTION app.enqueue_authentication_mail(uuid,text,timestamptz,text,text,text,text)
  OWNER TO {{owner_role}};
ALTER FUNCTION app.claim_authentication_mail(text,integer,uuid)
  OWNER TO {{owner_role}};
ALTER FUNCTION app.settle_authentication_mail(uuid,uuid,bigint,text,text,text,timestamptz)
  OWNER TO {{owner_role}};
ALTER FUNCTION app.prune_authentication_mail(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.enqueue_authentication_mail(uuid,text,timestamptz,text,text,text,text),
  app.claim_authentication_mail(text,integer,uuid),
  app.settle_authentication_mail(uuid,uuid,bigint,text,text,text,timestamptz),
  app.prune_authentication_mail(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.enqueue_authentication_mail(uuid,text,timestamptz,text,text,text,text)
  TO {{api_runtime_role}};
GRANT EXECUTE ON FUNCTION app.claim_authentication_mail(text,integer,uuid),
  app.settle_authentication_mail(uuid,uuid,bigint,text,text,text,timestamptz)
  TO {{worker_runtime_role}};
GRANT EXECUTE ON FUNCTION app.prune_authentication_mail(integer)
  TO {{maintenance_role}};
