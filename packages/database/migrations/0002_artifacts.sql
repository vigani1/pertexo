CREATE TABLE app.artifacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  purpose varchar(64) NOT NULL,
  storage_key varchar(512) NOT NULL,
  media_type varchar(255) NOT NULL,
  byte_length bigint NOT NULL,
  sha256 char(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_purpose_format
    CHECK (purpose ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT artifacts_storage_key_scope
    CHECK (
      storage_key = 'workspaces/' || workspace_id::text || '/artifacts/' || id::text
    ),
  CONSTRAINT artifacts_media_type_format
    CHECK (
      length(media_type) BETWEEN 3 AND 255
      AND media_type ~ '^[^[:space:]/;]+/[^\r\n]+$'
    ),
  CONSTRAINT artifacts_byte_length_bounded
    CHECK (byte_length BETWEEN 0 AND 5368709120),
  CONSTRAINT artifacts_sha256_format
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT artifacts_status_value
    CHECK (status IN ('pending', 'available', 'deleting', 'deleted')),
  CONSTRAINT artifacts_lifecycle_timestamps
    CHECK (
      (status = 'pending' AND finalized_at IS NULL AND deleted_at IS NULL)
      OR (status = 'available' AND finalized_at IS NOT NULL AND deleted_at IS NULL)
      OR (status = 'deleting' AND deleted_at IS NULL)
      OR (status = 'deleted' AND deleted_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX artifacts_storage_key_idx
  ON app.artifacts (storage_key);
CREATE INDEX artifacts_workspace_status_idx
  ON app.artifacts (workspace_id, status, id);
CREATE INDEX artifacts_pending_expiry_idx
  ON app.artifacts (workspace_id, expires_at, id)
  WHERE status = 'pending';

ALTER TABLE app.artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY artifacts_workspace_scope
  ON app.artifacts
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

GRANT SELECT, INSERT ON app.artifacts
  TO {{api_runtime_role}}, {{worker_runtime_role}};
GRANT UPDATE (status, finalized_at, deleted_at, updated_at) ON app.artifacts
  TO {{api_runtime_role}}, {{worker_runtime_role}};
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON app.artifacts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
