CREATE TABLE app.outbox_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  job_name varchar(128) NOT NULL,
  schema_version smallint NOT NULL,
  aggregate_type varchar(64) NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  payload_checksum char(64) NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(128),
  lease_token uuid,
  lease_expires_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  failed_at timestamptz,
  last_error_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_schema_version_positive
    CHECK (schema_version > 0),
  CONSTRAINT outbox_events_job_name_format
    CHECK (job_name ~ '^[a-z][a-z0-9-]{0,127}$'),
  CONSTRAINT outbox_events_aggregate_type_format
    CHECK (aggregate_type ~ '^[a-z][a-z0-9.-]{0,63}$'),
  CONSTRAINT outbox_events_attempts_nonnegative
    CHECK (publish_attempts >= 0),
  CONSTRAINT outbox_events_checksum_format
    CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outbox_events_payload_bounded
    CHECK (octet_length(payload::text) <= 4096),
  CONSTRAINT outbox_events_lease_owner_format
    CHECK (lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT outbox_events_error_code_format
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT outbox_events_lease_complete
    CHECK (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR
      (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT outbox_events_terminal_state_exclusive
    CHECK (NOT (published_at IS NOT NULL AND failed_at IS NOT NULL))
);

CREATE INDEX outbox_events_workspace_idx
  ON app.outbox_events (workspace_id, id);
CREATE INDEX outbox_events_due_idx
  ON app.outbox_events (available_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;
CREATE INDEX outbox_events_expired_lease_idx
  ON app.outbox_events (lease_expires_at, id)
  WHERE lease_expires_at IS NOT NULL
    AND published_at IS NULL
    AND failed_at IS NULL;

CREATE TABLE app.inbox_receipts (
  consumer_name varchar(128) NOT NULL,
  message_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  payload_checksum char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (consumer_name, message_id),
  CONSTRAINT inbox_receipts_consumer_name_format
    CHECK (consumer_name ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  CONSTRAINT inbox_receipts_checksum_format
    CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inbox_receipts_completion_order
    CHECK (completed_at IS NULL OR completed_at >= received_at)
);

CREATE INDEX inbox_receipts_workspace_idx
  ON app.inbox_receipts (workspace_id, received_at DESC);

ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.inbox_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inbox_receipts FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA app TO {{dispatcher_role}};

CREATE POLICY outbox_events_tenant_select
  ON app.outbox_events
  FOR SELECT
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

CREATE POLICY outbox_events_tenant_insert
  ON app.outbox_events
  FOR INSERT
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

CREATE POLICY outbox_events_dispatcher_select
  ON app.outbox_events
  FOR SELECT
  TO {{dispatcher_role}}
  USING (true);

CREATE POLICY outbox_events_dispatcher_update
  ON app.outbox_events
  FOR UPDATE
  TO {{dispatcher_role}}
  USING (true)
  WITH CHECK (true);

CREATE POLICY inbox_receipts_workspace_scope
  ON app.inbox_receipts
  FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

GRANT SELECT, INSERT ON app.outbox_events
  TO {{api_runtime_role}}, {{worker_runtime_role}};
GRANT SELECT ON app.outbox_events TO {{dispatcher_role}};
REVOKE UPDATE ON app.outbox_events FROM {{dispatcher_role}};
GRANT UPDATE (
  available_at,
  lease_owner,
  lease_token,
  lease_expires_at,
  publish_attempts,
  published_at,
  failed_at,
  last_error_code,
  updated_at
) ON app.outbox_events TO {{dispatcher_role}};
GRANT SELECT, INSERT, UPDATE ON app.inbox_receipts
  TO {{api_runtime_role}}, {{worker_runtime_role}};

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.outbox_events
  FROM {{api_runtime_role}}, {{worker_runtime_role}};
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.outbox_events
  FROM {{dispatcher_role}};
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.inbox_receipts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
