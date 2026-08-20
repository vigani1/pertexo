-- Phase 1 identity/workspace persistence. Platform identity records are not
-- tenant rows; memberships and audit facts carry direct workspace scope.

CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  email varchar(320) NOT NULL,
  display_name varchar(256) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_status_valid
    CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT users_email_format
    CHECK (email = btrim(email) AND length(email) BETWEEN 3 AND 320)
);

CREATE UNIQUE INDEX users_email_lower_unique
  ON app.users (lower(email));

CREATE TABLE app.auth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  issuer varchar(2048) NOT NULL,
  provider_subject varchar(255) NOT NULL,
  profile_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_user_fk
    FOREIGN KEY (user_id) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT auth_identities_issuer_format
    CHECK (length(issuer) BETWEEN 1 AND 2048),
  CONSTRAINT auth_identities_subject_nonempty
    CHECK (length(provider_subject) BETWEEN 1 AND 255),
  CONSTRAINT auth_identities_metadata_bounded
    CHECK (octet_length(profile_metadata::text) <= 8192)
);

CREATE UNIQUE INDEX auth_identities_issuer_subject_unique
  ON app.auth_identities (issuer, provider_subject);
CREATE INDEX auth_identities_user_idx
  ON app.auth_identities (user_id, id);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_digest char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent varchar(512),
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT sessions_token_digest_format
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT sessions_revocation_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX sessions_token_digest_unique
  ON app.sessions (token_digest);
CREATE INDEX sessions_user_active_idx
  ON app.sessions (user_id, expires_at, id)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx
  ON app.sessions (expires_at, id)
  WHERE revoked_at IS NULL;

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  slug varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL,
  deletion_requested_at timestamptz,
  deletion_requested_by uuid,
  deletion_reason varchar(512),
  purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_created_by_fk
    FOREIGN KEY (created_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT workspaces_deletion_requested_by_fk
    FOREIGN KEY (deletion_requested_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT workspaces_name_nonempty
    CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  CONSTRAINT workspaces_slug_format
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT workspaces_status_valid
    CHECK (status IN ('active', 'suspended', 'pending_deletion', 'deleted')),
  CONSTRAINT workspaces_deletion_state_valid
    CHECK (
      (status IN ('active', 'suspended')
        AND deletion_requested_at IS NULL
        AND deletion_requested_by IS NULL
        AND deletion_reason IS NULL
        AND purge_after IS NULL)
      OR
      (status IN ('pending_deletion', 'deleted')
        AND deletion_requested_at IS NOT NULL
        AND deletion_requested_by IS NOT NULL
        AND deletion_reason IS NOT NULL
        AND length(btrim(deletion_reason)) BETWEEN 1 AND 512
        AND purge_after IS NOT NULL
        AND purge_after > deletion_requested_at)
    )
);

CREATE UNIQUE INDEX workspaces_slug_lower_unique
  ON app.workspaces (lower(slug));
CREATE INDEX workspaces_status_purge_idx
  ON app.workspaces (status, purge_after, id)
  WHERE status = 'pending_deletion';

CREATE TABLE app.workspace_memberships (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_memberships_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_memberships_role_valid
    CHECK (role IN ('owner', 'admin', 'builder', 'operator', 'viewer')),
  CONSTRAINT workspace_memberships_status_valid
    CHECK (status IN ('active', 'suspended', 'removed'))
);

CREATE UNIQUE INDEX workspace_memberships_one_owner_unique
  ON app.workspace_memberships (workspace_id)
  WHERE role = 'owner' AND status <> 'removed';
CREATE INDEX workspace_memberships_workspace_status_idx
  ON app.workspace_memberships (workspace_id, status, user_id);
CREATE INDEX workspace_memberships_user_idx
  ON app.workspace_memberships (user_id, workspace_id);

CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  actor_user_id uuid,
  action varchar(128) NOT NULL,
  target_type varchar(64) NOT NULL,
  target_id uuid,
  request_id varchar(128),
  trace_id varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_action_format
    CHECK (action ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  CONSTRAINT audit_events_target_type_format
    CHECK (target_type ~ '^[a-z][a-z0-9._:-]{0,63}$'),
  CONSTRAINT audit_events_request_id_bounded
    CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT audit_events_trace_id_bounded
    CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 128),
  CONSTRAINT audit_events_metadata_bounded
    CHECK (octet_length(metadata::text) <= 8192)
);

CREATE INDEX audit_events_workspace_time_idx
  ON app.audit_events (workspace_id, occurred_at DESC, id);
CREATE INDEX audit_events_workspace_target_idx
  ON app.audit_events (workspace_id, target_type, target_id, occurred_at DESC);

ALTER TABLE app.workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_memberships_workspace_scope
  ON app.workspace_memberships
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

CREATE POLICY audit_events_workspace_select
  ON app.audit_events
  FOR SELECT
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

CREATE POLICY audit_events_workspace_insert
  ON app.audit_events
  FOR INSERT
  TO {{api_runtime_role}}
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

REVOKE ALL ON app.users, app.auth_identities, app.sessions, app.workspaces,
  app.workspace_memberships, app.audit_events
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT, INSERT ON app.users TO {{api_runtime_role}};
GRANT UPDATE (email, display_name, status, updated_at)
  ON app.users TO {{api_runtime_role}};
GRANT SELECT, INSERT ON app.auth_identities TO {{api_runtime_role}};
GRANT UPDATE (profile_metadata, updated_at)
  ON app.auth_identities TO {{api_runtime_role}};
GRANT SELECT, INSERT ON app.sessions TO {{api_runtime_role}};
GRANT UPDATE (revoked_at) ON app.sessions TO {{api_runtime_role}};
GRANT SELECT, INSERT ON app.workspaces TO {{api_runtime_role}};
GRANT UPDATE (
  status, deletion_requested_at, deletion_requested_by, deletion_reason,
  purge_after, updated_at
) ON app.workspaces TO {{api_runtime_role}};
-- The worker may inspect only the workspace lifecycle identity it needs for
-- admission. It must not read user email, authentication identities, or
-- session token digests.
GRANT SELECT (id, status) ON app.workspaces TO {{worker_runtime_role}};

GRANT SELECT, INSERT ON app.workspace_memberships TO {{api_runtime_role}};
GRANT UPDATE (role, status, updated_at)
  ON app.workspace_memberships TO {{api_runtime_role}};
GRANT SELECT ON app.audit_events TO {{api_runtime_role}};
GRANT INSERT ON app.audit_events TO {{api_runtime_role}};

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.users, app.auth_identities, app.sessions, app.workspaces,
  app.workspace_memberships, app.audit_events
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
