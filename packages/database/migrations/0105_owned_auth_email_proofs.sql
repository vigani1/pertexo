-- One-time identity-scoped email proofs. Raw bearer material is never stored.
-- API callers use narrow functions; the owner holds rows and writes audit facts.

CREATE TABLE app.auth_email_proofs (
  id uuid PRIMARY KEY,
  token_digest bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL,
  email varchar(320) NOT NULL,
  new_email varchar(320),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auth_email_proof_purpose_valid CHECK (
    purpose IN ('initial_verification','change_old','change_new')
  ),
  CONSTRAINT auth_email_proof_digest_valid CHECK (octet_length(token_digest)=32),
  CONSTRAINT auth_email_proof_new_email_valid CHECK (
    (purpose='initial_verification' AND new_email IS NULL)
    OR (purpose IN ('change_old','change_new') AND new_email IS NOT NULL)
  ),
  CONSTRAINT auth_email_proof_expiry_valid CHECK (expires_at>created_at)
);
CREATE INDEX auth_email_proofs_retention_idx
  ON app.auth_email_proofs(expires_at,id);
CREATE INDEX auth_email_proofs_user_idx
  ON app.auth_email_proofs(user_id,purpose,created_at);

CREATE TABLE app.identity_security_audit_facts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  event_type varchar(64) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  legal_hold_until timestamptz,
  CONSTRAINT identity_security_audit_event_valid CHECK (
    event_type IN ('email.initial_verified','email.old_confirmed',
                   'email.change_verified','method.linked','method.unlinked',
                   'legacy.method_migrated','password.changed',
                   'password.configured','password.reset')
  )
);
CREATE INDEX identity_security_audit_retention_idx
  ON app.identity_security_audit_facts(occurred_at,id);
CREATE INDEX identity_security_audit_user_idx
  ON app.identity_security_audit_facts(user_id,occurred_at);

REVOKE ALL ON app.auth_email_proofs,app.identity_security_audit_facts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};

CREATE FUNCTION app.issue_auth_email_proof(
  p_id uuid,p_digest bytea,p_user_id uuid,p_purpose text,
  p_email text,p_new_email text,p_expires_at timestamptz,
  p_mail_id uuid,p_mail_purpose text,p_mail_expires_at timestamptz,
  p_ciphertext text,p_nonce text,p_tag text,p_key_version text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
DECLARE v_user app.users%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL OR octet_length(p_digest)<>32
     OR p_purpose NOT IN ('initial_verification','change_old')
     OR p_email IS NULL OR length(p_email)>320
     OR p_expires_at<=clock_timestamp()
     OR p_expires_at>clock_timestamp()+interval '1 hour'
     OR (p_purpose='initial_verification' AND p_new_email IS NOT NULL)
     OR (p_purpose='change_old' AND
         (p_new_email IS NULL OR length(p_new_email)>320
          OR lower(p_new_email)=lower(p_email)))
     OR ((p_mail_id IS NULL) IS DISTINCT FROM (p_ciphertext IS NULL))
     OR (p_mail_id IS NOT NULL AND p_mail_purpose<>
         CASE WHEN p_purpose='change_old' THEN 'email_change_confirmation'
              ELSE 'verification' END) THEN
    RAISE EXCEPTION 'invalid email proof issuance' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_user FROM app.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.status<>'active'
     OR lower(v_user.email)<>lower(p_email)
     OR (p_purpose='initial_verification' AND v_user.email_verified)
     OR (p_purpose='change_old' AND NOT v_user.email_verified) THEN
    RETURN false;
  END IF;
  INSERT INTO app.auth_email_proofs
    (id,token_digest,user_id,purpose,email,new_email,expires_at)
  VALUES (p_id,p_digest,p_user_id,p_purpose,p_email,p_new_email,p_expires_at);
  IF p_mail_id IS NOT NULL THEN
    PERFORM app.enqueue_authentication_mail(
      p_mail_id,p_mail_purpose,p_mail_expires_at,
      p_ciphertext,p_nonce,p_tag,p_key_version);
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION app.consume_auth_email_proof(
  p_digest bytea,
  p_next_id uuid DEFAULT NULL,p_next_digest bytea DEFAULT NULL,
  p_next_expires_at timestamptz DEFAULT NULL,
  p_mail_id uuid DEFAULT NULL,p_mail_expires_at timestamptz DEFAULT NULL,
  p_ciphertext text DEFAULT NULL,p_nonce text DEFAULT NULL,
  p_tag text DEFAULT NULL,p_key_version text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
DECLARE v_user app.users%ROWTYPE;
        v_proof app.auth_email_proofs%ROWTYPE;
        v_user_id uuid;
BEGIN
  IF p_digest IS NULL OR octet_length(p_digest)<>32 THEN
    RETURN 'invalid';
  END IF;
  SELECT user_id INTO v_user_id FROM app.auth_email_proofs
    WHERE token_digest=p_digest;
  IF v_user_id IS NULL THEN RETURN 'invalid'; END IF;
  SELECT * INTO v_user FROM app.users WHERE id=v_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.status<>'active' THEN RETURN 'invalid'; END IF;
  SELECT * INTO v_proof FROM app.auth_email_proofs
    WHERE token_digest=p_digest FOR UPDATE;
  IF NOT FOUND OR v_proof.consumed_at IS NOT NULL
     OR v_proof.expires_at<=clock_timestamp()
     OR v_proof.user_id<>v_user.id
     OR lower(v_proof.email)<>lower(v_user.email) THEN
    RETURN 'invalid';
  END IF;
  IF v_proof.purpose='initial_verification' THEN
    IF v_user.email_verified THEN RETURN 'invalid'; END IF;
    UPDATE app.users SET email_verified=true,updated_at=clock_timestamp()
      WHERE id=v_user.id;
    DELETE FROM app.auth_sessions WHERE user_id=v_user.id;
    INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
      VALUES (gen_random_uuid(),v_user.id,'email.initial_verified');
  ELSIF v_proof.purpose='change_old' THEN
    IF NOT v_user.email_verified OR p_next_id IS NULL
       OR p_next_digest IS NULL OR octet_length(p_next_digest)<>32
       OR p_next_expires_at<=clock_timestamp()
       OR p_next_expires_at>clock_timestamp()+interval '1 hour'
       OR (p_mail_id IS NULL) IS DISTINCT FROM (p_ciphertext IS NULL)
       THEN RETURN 'invalid'; END IF;
    INSERT INTO app.auth_email_proofs
      (id,token_digest,user_id,purpose,email,new_email,expires_at)
    VALUES (p_next_id,p_next_digest,v_user.id,'change_new',
            v_proof.email,v_proof.new_email,p_next_expires_at);
    IF p_mail_id IS NOT NULL THEN
      PERFORM app.enqueue_authentication_mail(
        p_mail_id,'verification',p_mail_expires_at,
        p_ciphertext,p_nonce,p_tag,p_key_version);
    END IF;
    INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
      VALUES (gen_random_uuid(),v_user.id,'email.old_confirmed');
  ELSIF v_proof.purpose='change_new' THEN
    IF v_proof.new_email IS NULL OR NOT v_user.email_verified THEN
      RETURN 'invalid';
    END IF;
    UPDATE app.users
       SET email=v_proof.new_email,email_verified=true,
           updated_at=clock_timestamp()
     WHERE id=v_user.id;
    INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
      VALUES (gen_random_uuid(),v_user.id,'email.change_verified');
  ELSE
    RETURN 'invalid';
  END IF;
  UPDATE app.auth_email_proofs SET consumed_at=clock_timestamp()
    WHERE id=v_proof.id;
  RETURN v_proof.purpose;
END;
$$;

-- Narrow bearer-proof lookup prepares the second mail before atomic consumption.
-- It discloses no row identifiers, stored digests or session material.
CREATE FUNCTION app.inspect_auth_email_proof(p_digest bytea)
RETURNS TABLE(purpose text,new_email text,display_name text)
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
  SELECT proof.purpose::text,proof.new_email::text,users.display_name::text
    FROM app.auth_email_proofs proof
    JOIN app.users users ON users.id=proof.user_id
   WHERE proof.token_digest=p_digest
     AND proof.consumed_at IS NULL
     AND proof.expires_at>clock_timestamp()
     AND users.status='active'
     AND lower(users.email)=lower(proof.email)
   LIMIT 1;
$$;

CREATE FUNCTION app.prune_auth_email_evidence(p_limit integer)
RETURNS TABLE(proofs_deleted integer,audit_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
DECLARE v_proofs integer; v_audit integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid email evidence prune limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.auth_email_proofs
     WHERE expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.auth_email_proofs proof USING candidates
    WHERE proof.id=candidates.id;
  GET DIAGNOSTICS v_proofs=ROW_COUNT;
  WITH candidates AS (
    SELECT id FROM app.identity_security_audit_facts
     WHERE occurred_at<=clock_timestamp()-interval '365 days'
       AND (legal_hold_until IS NULL OR legal_hold_until<=clock_timestamp())
     ORDER BY occurred_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.identity_security_audit_facts audit USING candidates
    WHERE audit.id=candidates.id;
  GET DIAGNOSTICS v_audit=ROW_COUNT;
  RETURN QUERY SELECT v_proofs,v_audit;
END;
$$;

CREATE FUNCTION app.record_identity_method_audit_fact(
  p_user_id uuid,p_event_type text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
BEGIN
  IF p_user_id IS NULL OR p_event_type NOT IN
    ('method.linked','method.unlinked','legacy.method_migrated',
     'password.changed','password.configured','password.reset')
     OR NOT EXISTS (SELECT 1 FROM app.users WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'invalid identity audit fact' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
  VALUES (gen_random_uuid(),p_user_id,p_event_type);
END;
$$;

ALTER FUNCTION app.issue_auth_email_proof(uuid,bytea,uuid,text,text,text,timestamptz,uuid,text,timestamptz,text,text,text,text)
  OWNER TO {{owner_role}};
ALTER FUNCTION app.consume_auth_email_proof(bytea,uuid,bytea,timestamptz,uuid,timestamptz,text,text,text,text)
  OWNER TO {{owner_role}};
ALTER FUNCTION app.inspect_auth_email_proof(bytea) OWNER TO {{owner_role}};
ALTER FUNCTION app.prune_auth_email_evidence(integer)
  OWNER TO {{owner_role}};
ALTER FUNCTION app.record_identity_method_audit_fact(uuid,text)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION
  app.issue_auth_email_proof(uuid,bytea,uuid,text,text,text,timestamptz,uuid,text,timestamptz,text,text,text,text),
  app.consume_auth_email_proof(bytea,uuid,bytea,timestamptz,uuid,timestamptz,text,text,text,text),
  app.inspect_auth_email_proof(bytea),
  app.prune_auth_email_evidence(integer),
  app.record_identity_method_audit_fact(uuid,text)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION
  app.issue_auth_email_proof(uuid,bytea,uuid,text,text,text,timestamptz,uuid,text,timestamptz,text,text,text,text),
  app.consume_auth_email_proof(bytea,uuid,bytea,timestamptz,uuid,timestamptz,text,text,text,text),
  app.inspect_auth_email_proof(bytea)
  TO {{api_runtime_role}};
GRANT EXECUTE ON FUNCTION app.prune_auth_email_evidence(integer)
  TO {{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.record_identity_method_audit_fact(uuid,text)
  TO {{api_runtime_role}};
