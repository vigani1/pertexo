-- OIDC authorization transactions are platform records. State is represented
-- only by its lower-case SHA-256 digest; PKCE and nonce values are sealed by an
-- injected application encryption adapter before they cross this boundary.

CREATE TABLE app.oidc_login_transactions (
  state_digest char(64) PRIMARY KEY,
  code_verifier_ciphertext text NOT NULL,
  code_verifier_nonce varchar(128) NOT NULL,
  code_verifier_tag varchar(256) NOT NULL,
  code_verifier_key_version varchar(64) NOT NULL,
  nonce_ciphertext text NOT NULL,
  nonce_nonce varchar(128) NOT NULL,
  nonce_tag varchar(256) NOT NULL,
  nonce_key_version varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oidc_login_transactions_state_digest_format
    CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oidc_login_transactions_ciphertext_bounded
    CHECK (
      length(code_verifier_ciphertext) BETWEEN 1 AND 16384
      AND length(nonce_ciphertext) BETWEEN 1 AND 16384
    ),
  CONSTRAINT oidc_login_transactions_seal_metadata_bounded
    CHECK (
      length(code_verifier_nonce) BETWEEN 1 AND 128
      AND length(code_verifier_tag) BETWEEN 1 AND 256
      AND length(code_verifier_key_version) BETWEEN 1 AND 64
      AND length(nonce_nonce) BETWEEN 1 AND 128
      AND length(nonce_tag) BETWEEN 1 AND 256
      AND length(nonce_key_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT oidc_login_transactions_expiry_valid
    CHECK (expires_at > created_at),
  CONSTRAINT oidc_login_transactions_consumed_at_valid
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX oidc_login_transactions_expiry_idx
  ON app.oidc_login_transactions (expires_at, state_digest)
  WHERE consumed_at IS NULL;

REVOKE ALL ON app.oidc_login_transactions
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT, INSERT ON app.oidc_login_transactions TO {{api_runtime_role}};
GRANT UPDATE (consumed_at) ON app.oidc_login_transactions TO {{api_runtime_role}};
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.oidc_login_transactions
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
