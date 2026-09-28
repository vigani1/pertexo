-- ADR 054 foundation only. No producer, consumer registration or activation.
-- Source identity is immutable; delayed transport cannot reconstruct missing
-- source evidence. Fixed hours make horizons independent of session timezone.
CREATE TABLE app.workspace_inbox_sources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  terminal_event_sequence bigint NOT NULL CHECK (terminal_event_sequence > 0),
  kind varchar(32) NOT NULL CHECK (kind IN ('failed','timed_out','outcome_unknown')),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  evidence_until timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','captured','blocked','completed','expired')),
  captured_at timestamptz,
  audience_count bigint NOT NULL DEFAULT 0 CHECK (audience_count >= 0),
  last_recipient_user_id uuid,
  consecutive_attempts integer NOT NULL DEFAULT 0
    CHECK (consecutive_attempts BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  lease_owner varchar(128),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_inbox_sources_run_workspace_fk
    FOREIGN KEY (workspace_id,run_id) REFERENCES app.workflow_runs(workspace_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_inbox_sources_horizons_valid CHECK (
    expires_at=occurred_at+interval '720 hours'
    AND evidence_until=occurred_at+interval '2160 hours'),
  CONSTRAINT workspace_inbox_sources_capture_valid CHECK (
    (captured_at IS NULL AND audience_count=0 AND last_recipient_user_id IS NULL
      AND status IN ('pending','blocked','expired'))
    OR (captured_at IS NOT NULL AND captured_at<expires_at
      AND status IN ('captured','blocked','completed','expired'))),
  CONSTRAINT workspace_inbox_sources_lease_valid CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND fence_token>0 AND status IN ('pending','captured')))
);
CREATE UNIQUE INDEX workspace_inbox_sources_workspace_identity_unique
  ON app.workspace_inbox_sources(workspace_id,id);
CREATE UNIQUE INDEX workspace_inbox_sources_terminal_unique
  ON app.workspace_inbox_sources(workspace_id,run_id,terminal_event_sequence,kind);
CREATE INDEX workspace_inbox_sources_due_idx
  ON app.workspace_inbox_sources(next_attempt_at,id)
  WHERE status IN ('pending','captured');
CREATE INDEX workspace_inbox_sources_evidence_idx
  ON app.workspace_inbox_sources(workspace_id,evidence_until,id);

CREATE TABLE app.workspace_inbox_audience (
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  user_id uuid NOT NULL,
  observed_role_revision integer NOT NULL CHECK (observed_role_revision>0),
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','inserted','skipped')),
  processed_at timestamptz,
  PRIMARY KEY (workspace_id,source_id,user_id),
  CONSTRAINT workspace_inbox_audience_source_workspace_fk
    FOREIGN KEY (workspace_id,source_id) REFERENCES app.workspace_inbox_sources(workspace_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_inbox_audience_membership_workspace_fk
    FOREIGN KEY (workspace_id,user_id) REFERENCES app.workspace_memberships(workspace_id,user_id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_inbox_audience_progress_valid CHECK (
    (status='pending' AND processed_at IS NULL)
    OR (status IN ('inserted','skipped') AND processed_at IS NOT NULL))
);

CREATE TABLE app.workspace_inbox_recipient_state (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  PRIMARY KEY (workspace_id,user_id),
  CONSTRAINT workspace_inbox_recipient_state_membership_workspace_fk
    FOREIGN KEY (workspace_id,user_id) REFERENCES app.workspace_memberships(workspace_id,user_id)
    ON DELETE RESTRICT
);

CREATE TABLE app.workspace_inbox_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  user_id uuid NOT NULL,
  creation_revision bigint NOT NULL CHECK (creation_revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  read_at timestamptz,
  CONSTRAINT workspace_inbox_entries_source_workspace_fk
    FOREIGN KEY (workspace_id,source_id) REFERENCES app.workspace_inbox_sources(workspace_id,id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_inbox_entries_recipient_workspace_fk
    FOREIGN KEY (workspace_id,user_id) REFERENCES app.workspace_inbox_recipient_state(workspace_id,user_id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_inbox_entries_audience_workspace_fk
    FOREIGN KEY (workspace_id,source_id,user_id) REFERENCES app.workspace_inbox_audience(workspace_id,source_id,user_id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_inbox_entries_expiry_valid
    CHECK (expires_at=created_at+interval '720 hours'),
  CONSTRAINT workspace_inbox_entries_read_time_valid
    CHECK (read_at IS NULL OR read_at>=created_at)
);
CREATE UNIQUE INDEX workspace_inbox_entries_source_recipient_unique
  ON app.workspace_inbox_entries(workspace_id,source_id,user_id);
CREATE UNIQUE INDEX workspace_inbox_entries_recipient_revision_unique
  ON app.workspace_inbox_entries(workspace_id,user_id,creation_revision);
CREATE INDEX workspace_inbox_entries_recipient_created_idx
  ON app.workspace_inbox_entries(workspace_id,user_id,created_at DESC,id DESC);
CREATE INDEX workspace_inbox_entries_recipient_unread_idx
  ON app.workspace_inbox_entries(workspace_id,user_id,created_at DESC,id DESC)
  WHERE read_at IS NULL;
CREATE INDEX workspace_inbox_entries_expiry_idx
  ON app.workspace_inbox_entries(workspace_id,expires_at,id);

-- API-only predicate. SECURITY INVOKER retains existing workspace membership
-- RLS, ordinary table grants and actor context; it grants no projection powers.
CREATE FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,app AS $$
  SELECT p_workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')
    AND p_user_id::text=NULLIF(current_setting('app.actor_id',true),'')
    AND EXISTS (
      SELECT 1 FROM app.workspace_memberships membership
      JOIN app.workspaces workspace ON workspace.id=membership.workspace_id
      JOIN app.users recipient ON recipient.id=membership.user_id
      WHERE membership.workspace_id=p_workspace_id AND membership.user_id=p_user_id
        AND workspace.status='active' AND recipient.status='active'
        AND membership.status='active' AND membership.role IN ('owner','admin','operator')
    );
$$;
REVOKE ALL ON FUNCTION app.workspace_inbox_recipient_eligible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspace_inbox_recipient_eligible(uuid,uuid) TO {{api_runtime_role}};

-- Read timestamps are DB-assigned, monotonic, immutable once present. UPDATE
-- grants cannot reset a notice to unread or manufacture an earlier/later read.
CREATE FUNCTION app.preserve_workspace_inbox_read_time()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,app AS $$
BEGIN
  IF OLD.read_at IS NOT NULL THEN NEW.read_at:=OLD.read_at;
  ELSIF NEW.read_at IS NOT NULL THEN NEW.read_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_workspace_inbox_read_time() FROM PUBLIC;
CREATE TRIGGER workspace_inbox_entries_read_time
  BEFORE UPDATE OF read_at ON app.workspace_inbox_entries
  FOR EACH ROW EXECUTE FUNCTION app.preserve_workspace_inbox_read_time();

-- API can read only its eligible recipient's unexpired entries and state.
-- Worker access is separate, explicitly privileged tenant-scoped projection
-- authority. Future insertion commands must recheck eligibility under locks;
-- these policies do not pretend to provide atomic identity/session enforcement.
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'workspace_inbox_sources','workspace_inbox_audience',
    'workspace_inbox_recipient_state','workspace_inbox_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',v_table);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO {{owner_role}}, {{worker_runtime_role}} USING (workspace_id::text=NULLIF(current_setting(''app.workspace_id'',true),'''')) WITH CHECK (workspace_id::text=NULLIF(current_setting(''app.workspace_id'',true),''''))',v_table||'_projection_scope',v_table);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}}, {{maintenance_role}}, {{operator_role}}, {{lifecycle_command_role}}',v_table);
  END LOOP;
END $$;
CREATE POLICY workspace_inbox_entries_recipient_select ON app.workspace_inbox_entries
  FOR SELECT TO {{api_runtime_role}}
  USING (app.workspace_inbox_recipient_eligible(workspace_id,user_id) AND expires_at>statement_timestamp());
CREATE POLICY workspace_inbox_entries_recipient_update ON app.workspace_inbox_entries
  FOR UPDATE TO {{api_runtime_role}}
  USING (app.workspace_inbox_recipient_eligible(workspace_id,user_id) AND expires_at>statement_timestamp())
  WITH CHECK (app.workspace_inbox_recipient_eligible(workspace_id,user_id) AND expires_at>statement_timestamp());
CREATE POLICY workspace_inbox_recipient_state_recipient_scope ON app.workspace_inbox_recipient_state
  FOR ALL TO {{api_runtime_role}}
  USING (app.workspace_inbox_recipient_eligible(workspace_id,user_id))
  WITH CHECK (app.workspace_inbox_recipient_eligible(workspace_id,user_id));
-- Sources are required to render a recipient's own entries; API cannot enumerate
-- sources with no currently visible entry for that recipient.
CREATE POLICY workspace_inbox_sources_recipient_select ON app.workspace_inbox_sources
  FOR SELECT TO {{api_runtime_role}}
  USING (EXISTS (SELECT 1 FROM app.workspace_inbox_entries entry
    WHERE entry.workspace_id=workspace_inbox_sources.workspace_id
      AND entry.source_id=workspace_inbox_sources.id));

GRANT SELECT (id,workspace_id,run_id,kind,occurred_at)
  ON app.workspace_inbox_sources TO {{api_runtime_role}};
GRANT SELECT ON app.workspace_inbox_recipient_state,app.workspace_inbox_entries
  TO {{api_runtime_role}};
GRANT INSERT ON app.workspace_inbox_recipient_state TO {{api_runtime_role}};
GRANT UPDATE (revision) ON app.workspace_inbox_recipient_state TO {{api_runtime_role}};
GRANT UPDATE (read_at) ON app.workspace_inbox_entries TO {{api_runtime_role}};
GRANT SELECT,INSERT ON app.workspace_inbox_sources,app.workspace_inbox_audience,
  app.workspace_inbox_recipient_state,app.workspace_inbox_entries TO {{worker_runtime_role}};
GRANT UPDATE (status,captured_at,audience_count,last_recipient_user_id,
  consecutive_attempts,next_attempt_at,fence_token,lease_owner,lease_token,lease_expires_at,updated_at)
  ON app.workspace_inbox_sources TO {{worker_runtime_role}};
GRANT UPDATE (status,processed_at) ON app.workspace_inbox_audience TO {{worker_runtime_role}};
GRANT UPDATE (revision) ON app.workspace_inbox_recipient_state TO {{worker_runtime_role}};

-- Explicit purge participation, child before parent, retaining the current
-- function's ledger/hold/lease/page behavior. No cascade-only cleanup claim.
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  IF position('''workflow_runs''' in v_definition)=0 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible';
  END IF;
  v_definition:=replace(v_definition,'''workflow_runs''',
    '''workspace_inbox_entries'', ''workspace_inbox_audience'', ''workspace_inbox_recipient_state'', ''workspace_inbox_sources'', ''workflow_runs''');
  EXECUTE v_definition;
END $$;
