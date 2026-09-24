-- Better Auth foundation (ADR 039). Pertexo users remain the stable identity
-- rows; Better Auth owns authentication methods, verification records and the
-- sole browser-session table after cutover.

ALTER TABLE app.users
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image text;

CREATE TABLE app.auth_accounts (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auth_accounts_provider_identity_unique
    UNIQUE(provider_id, account_id)
);

CREATE INDEX auth_accounts_user_idx
  ON app.auth_accounts(user_id, id);

CREATE TABLE app.auth_sessions (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  CONSTRAINT auth_sessions_expiry_after_creation
    CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_expiry_idx
  ON app.auth_sessions(user_id, expires_at, id);
CREATE INDEX auth_sessions_expiry_idx
  ON app.auth_sessions(expires_at, id);

CREATE TABLE app.auth_verifications (
  id uuid PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX auth_verifications_identifier_idx
  ON app.auth_verifications(identifier, id);
CREATE INDEX auth_verifications_expiry_idx
  ON app.auth_verifications(expires_at, id);

-- Old opaque credentials cannot cross the authority cutover.
UPDATE app.sessions
   SET revoked_at=coalesce(revoked_at, clock_timestamp());

REVOKE ALL ON app.auth_accounts, app.auth_sessions, app.auth_verifications
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.auth_accounts, app.auth_sessions, app.auth_verifications
  TO {{api_runtime_role}};

GRANT UPDATE (email, display_name, email_verified, image, updated_at)
  ON app.users TO {{api_runtime_role}};
