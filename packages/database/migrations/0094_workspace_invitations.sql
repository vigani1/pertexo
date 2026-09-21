-- Workspace invitations and browser-bound acceptance (ADR 038).

ALTER TABLE app.oidc_login_transactions
  ADD COLUMN continuation_kind varchar(32),
  ADD COLUMN continuation_ref jsonb,
  ADD CONSTRAINT oidc_login_transactions_continuation_shape CHECK (
    (continuation_kind IS NULL AND continuation_ref IS NULL)
    OR (
      continuation_kind='invitation_acceptance'
      AND continuation_ref IS NOT NULL
      AND jsonb_typeof(continuation_ref)='object'
      AND continuation_ref ?& ARRAY['workspaceId','intentId','bindingDigest']
    )
  );

CREATE TABLE app.workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  recipient_email varchar(320) NOT NULL,
  normalized_email varchar(320) NOT NULL,
  role varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  revision integer NOT NULL DEFAULT 1,
  token_digest char(64) NOT NULL,
  delivery_status varchar(32) NOT NULL DEFAULT 'queued',
  created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  accepted_by uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_invitations_role_valid
    CHECK (role IN ('admin','builder','operator','viewer')),
  CONSTRAINT workspace_invitations_status_valid
    CHECK (status IN ('pending','accepted','revoked','expired')),
  CONSTRAINT workspace_invitations_delivery_status_valid
    CHECK (delivery_status IN ('queued','submitted','failed','canceled')),
  CONSTRAINT workspace_invitations_revision_positive CHECK (revision > 0),
  CONSTRAINT workspace_invitations_token_digest_valid
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_invitations_normalized_email_valid
    CHECK (normalized_email=lower(btrim(recipient_email))),
  CONSTRAINT workspace_invitations_terminal_shape CHECK (
    (status='accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (status='revoked' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL)
    OR (status IN ('pending','expired') AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX workspace_invitations_pending_recipient_unique
  ON app.workspace_invitations(workspace_id,normalized_email)
  WHERE status='pending';
CREATE UNIQUE INDEX workspace_invitations_token_digest_unique
  ON app.workspace_invitations(workspace_id,id,token_digest);
CREATE INDEX workspace_invitations_list_idx
  ON app.workspace_invitations(workspace_id,created_at DESC,id DESC);
CREATE INDEX workspace_invitations_expiry_idx
  ON app.workspace_invitations(expires_at,id) WHERE status='pending';

CREATE TABLE app.workspace_invitation_command_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  operation varchar(32) NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(32) NOT NULL,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_invitation_receipts_operation_valid
    CHECK (operation IN ('create','resend','revoke','accept')),
  CONSTRAINT workspace_invitation_receipts_status_valid
    CHECK (status IN ('in_progress','completed')),
  CONSTRAINT workspace_invitation_receipts_hashes_valid
    CHECK (key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_invitation_receipts_result_valid CHECK (
    (status='in_progress' AND result_ref IS NULL)
    OR (status='completed' AND result_ref IS NOT NULL)
  )
);
CREATE UNIQUE INDEX workspace_invitation_receipts_key_unique
  ON app.workspace_invitation_command_receipts(actor_user_id,workspace_id,operation,key_hash);
CREATE INDEX workspace_invitation_receipts_workspace_idx
  ON app.workspace_invitation_command_receipts(workspace_id,created_at,id);

CREATE TABLE app.workspace_invitation_delivery_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES app.workspace_invitations(id) ON DELETE CASCADE,
  invitation_revision integer NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  token_ciphertext text,
  token_nonce varchar(128),
  token_tag varchar(256),
  token_key_version varchar(64),
  provider_reference varchar(512),
  failure_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_invitation_delivery_revision_positive
    CHECK (invitation_revision > 0),
  CONSTRAINT workspace_invitation_delivery_status_valid
    CHECK (status IN ('queued','submitted','failed','unknown','canceled')),
  CONSTRAINT workspace_invitation_delivery_sealed_shape CHECK (
    (token_ciphertext IS NULL AND token_nonce IS NULL AND token_tag IS NULL AND token_key_version IS NULL)
    OR (token_ciphertext IS NOT NULL AND token_nonce IS NOT NULL AND token_tag IS NOT NULL AND token_key_version IS NOT NULL)
  )
);
CREATE UNIQUE INDEX workspace_invitation_delivery_generation_unique
  ON app.workspace_invitation_delivery_attempts(invitation_id,invitation_revision);
CREATE INDEX workspace_invitation_delivery_workspace_idx
  ON app.workspace_invitation_delivery_attempts(workspace_id,created_at,id);

CREATE TABLE app.workspace_invitation_acceptance_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES app.workspace_invitations(id) ON DELETE CASCADE,
  invitation_revision integer NOT NULL,
  binding_digest char(64) NOT NULL,
  csrf_digest char(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  verified_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  verified_email varchar(320),
  verified_at timestamptz,
  accepted_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  receipt jsonb,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  abandoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_invitation_intents_revision_positive
    CHECK (invitation_revision > 0),
  CONSTRAINT workspace_invitation_intents_digests_valid
    CHECK (binding_digest ~ '^[0-9a-f]{64}$' AND csrf_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_invitation_intents_status_valid
    CHECK (status IN ('pending','verified','wrong_account','completed','abandoned','superseded')),
  CONSTRAINT workspace_invitation_intents_verification_shape CHECK (
    (verified_user_id IS NULL AND verified_email IS NULL AND verified_at IS NULL)
    OR (verified_user_id IS NOT NULL AND verified_email IS NOT NULL AND verified_at IS NOT NULL)
  ),
  CONSTRAINT workspace_invitation_intents_completion_shape CHECK (
    (status='completed' AND accepted_user_id IS NOT NULL AND receipt IS NOT NULL AND completed_at IS NOT NULL)
    OR (status<>'completed' AND accepted_user_id IS NULL AND receipt IS NULL AND completed_at IS NULL)
  )
);
CREATE UNIQUE INDEX workspace_invitation_intents_binding_unique
  ON app.workspace_invitation_acceptance_intents(workspace_id,binding_digest);
CREATE INDEX workspace_invitation_intents_expiry_idx
  ON app.workspace_invitation_acceptance_intents(expires_at,id);
CREATE INDEX workspace_invitation_intents_invitation_idx
  ON app.workspace_invitation_acceptance_intents(workspace_id,invitation_id,invitation_revision,id);

CREATE FUNCTION app.apply_workspace_invitation_deletion_side_effects()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_prior_workspace text;
BEGIN
  IF NEW.status<>'pending_deletion' THEN RETURN NEW; END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  UPDATE app.workspace_invitation_acceptance_intents
    SET status='superseded',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status IN ('pending','verified','wrong_account');
  UPDATE app.workspace_invitation_delivery_attempts
    SET status='canceled',token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,
        token_key_version=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status IN ('queued','failed','unknown');
  UPDATE app.workspace_invitations
    SET status='revoked',revision=revision+1,revoked_at=clock_timestamp(),
        delivery_status='canceled',updated_at=clock_timestamp()
    WHERE workspace_id=NEW.id AND status='pending';
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;
CREATE TRIGGER workspaces_apply_invitation_deletion_side_effects
  AFTER UPDATE OF status ON app.workspaces FOR EACH ROW
  WHEN (NEW.status='pending_deletion')
  EXECUTE FUNCTION app.apply_workspace_invitation_deletion_side_effects();
REVOKE ALL ON FUNCTION app.apply_workspace_invitation_deletion_side_effects() FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_invitations',
    'workspace_invitation_command_receipts',
    'workspace_invitation_delivery_attempts',
    'workspace_invitation_acceptance_intents'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO {{api_runtime_role}}, {{worker_runtime_role}} USING (workspace_id::text=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK (workspace_id::text=NULLIF(current_setting(''app.workspace_id'',true),''''))',
      table_name||'_workspace_scope',table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR ALL TO {{owner_role}} USING (true) WITH CHECK (true)',
      table_name||'_owner_maintenance',table_name
    );
  END LOOP;
END $$;

REVOKE ALL ON app.workspace_invitations,
  app.workspace_invitation_command_receipts,
  app.workspace_invitation_delivery_attempts,
  app.workspace_invitation_acceptance_intents
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT,INSERT ON app.workspace_invitations,
  app.workspace_invitation_command_receipts,
  app.workspace_invitation_delivery_attempts,
  app.workspace_invitation_acceptance_intents TO {{api_runtime_role}};
GRANT UPDATE ON app.workspace_invitations,
  app.workspace_invitation_command_receipts,
  app.workspace_invitation_delivery_attempts,
  app.workspace_invitation_acceptance_intents TO {{api_runtime_role}};
GRANT SELECT ON app.workspace_invitations,
  app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};
GRANT UPDATE (delivery_status,updated_at) ON app.workspace_invitations TO {{worker_runtime_role}};
GRANT UPDATE (status,provider_reference,failure_code,token_ciphertext,token_nonce,token_tag,token_key_version,updated_at)
  ON app.workspace_invitation_delivery_attempts TO {{worker_runtime_role}};

REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON app.workspace_invitations,
  app.workspace_invitation_command_receipts,
  app.workspace_invitation_delivery_attempts,
  app.workspace_invitation_acceptance_intents
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

-- Terminal invitation addresses are operational data, not durable audit facts.
-- Minimize them after the approved 90-day window while respecting legal holds.
CREATE FUNCTION app.minimize_terminal_workspace_invitation_pii(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_ids uuid[];
  v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invitation PII minimization limit must be between 1 and 1000'
      USING ERRCODE='22023';
  END IF;

  SELECT array_agg(candidate.id ORDER BY candidate.terminal_at,candidate.id)
    INTO v_ids
    FROM (
      SELECT invitation.id,
             coalesce(invitation.accepted_at,invitation.revoked_at,invitation.updated_at) terminal_at
        FROM app.workspace_invitations invitation
       WHERE invitation.status IN ('accepted','revoked','expired')
         AND invitation.recipient_email NOT LIKE 'minimized+%@invalid.pertexo'
         AND coalesce(invitation.accepted_at,invitation.revoked_at,invitation.updated_at)
             <= clock_timestamp()-interval '90 days'
         AND NOT EXISTS (
           SELECT 1 FROM app.workspace_legal_holds hold
            WHERE hold.workspace_id=invitation.workspace_id
              AND hold.released_sequence IS NULL
         )
       ORDER BY terminal_at,invitation.id
       LIMIT p_limit
       FOR UPDATE OF invitation SKIP LOCKED
    ) candidate;

  IF v_ids IS NULL THEN RETURN 0; END IF;

  UPDATE app.workspace_invitation_acceptance_intents intent
     SET verified_user_id=NULL,verified_email=NULL,verified_at=NULL,
         updated_at=clock_timestamp()
   WHERE intent.invitation_id=ANY(v_ids)
     AND intent.verified_email IS NOT NULL;

  UPDATE app.workspace_invitation_command_receipts receipt
     SET result_ref=jsonb_set(
           receipt.result_ref,
           '{invitation,email}',
           to_jsonb(('minimized+'||(receipt.result_ref->'invitation'->>'id')||'@invalid.pertexo')::text),
           false
         ),
         updated_at=clock_timestamp()
   WHERE receipt.result_ref->'invitation' ? 'email'
     AND (receipt.result_ref->'invitation'->>'id')::uuid=ANY(v_ids);

  UPDATE app.workspace_invitations invitation
     SET recipient_email='minimized+'||invitation.id::text||'@invalid.pertexo',
         normalized_email='minimized+'||invitation.id::text||'@invalid.pertexo',
         updated_at=clock_timestamp()
   WHERE invitation.id=ANY(v_ids);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END $$;
ALTER FUNCTION app.minimize_terminal_workspace_invitation_pii(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.minimize_terminal_workspace_invitation_pii(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}},
    {{dispatcher_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.minimize_terminal_workspace_invitation_pii(integer)
  TO {{maintenance_role}};

-- Add invitation-owned rows to the bounded workspace purge before memberships.
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  v_definition:=replace(
    v_definition,
    '''workspace_member_role_command_receipts'', ''workspace_memberships''',
    '''workspace_invitation_acceptance_intents'', ''workspace_invitation_delivery_attempts'', ''workspace_invitation_command_receipts'', ''workspace_invitations'', ''workspace_member_role_command_receipts'', ''workspace_memberships'''
  );
  IF position('workspace_invitation_acceptance_intents' in v_definition)=0 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible';
  END IF;
  EXECUTE v_definition;
END $$;
