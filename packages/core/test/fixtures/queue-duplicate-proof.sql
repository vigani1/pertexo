-- TEST-ONLY Phase 0D ledger. This file is applied by integration tests and is
-- intentionally absent from production migrations and the runtime schema API.
CREATE TABLE IF NOT EXISTS app.queue_duplicate_probe_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  logical_attempt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, logical_attempt_id)
);

CREATE TABLE IF NOT EXISTS app.queue_duplicate_probe_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  logical_attempt_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, logical_attempt_id, sequence)
);

CREATE TABLE IF NOT EXISTS app.queue_duplicate_probe_usage (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS app.queue_duplicate_probe_provider_effects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  outcome varchar(32) NOT NULL CHECK (outcome IN ('accepted', 'outcome_unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

-- The main consumer inserts this intent and its provider-dispatch outbox event
-- in the same workspace transaction. A separate provider consumer records only
-- the final result after performing the external call.
CREATE TABLE IF NOT EXISTS app.queue_duplicate_probe_provider_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  logical_attempt_id uuid NOT NULL,
  outbox_event_id uuid NOT NULL REFERENCES app.outbox_events(id),
  idempotency_key varchar(128) NOT NULL,
  outcome varchar(32) NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'accepted', 'outcome_unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, logical_attempt_id),
  UNIQUE (workspace_id, outbox_event_id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT queue_duplicate_probe_provider_intent_completion
    CHECK (
      (outcome = 'pending' AND completed_at IS NULL)
      OR (outcome <> 'pending' AND completed_at IS NOT NULL)
    )
);

-- A small domain-acceptance row used to prove acceptance and outbox commit or
-- rollback together without introducing Phase 1 production schema early.
CREATE TABLE IF NOT EXISTS app.queue_duplicate_probe_acceptances (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  acceptance_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  outbox_event_id uuid REFERENCES app.outbox_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, acceptance_key),
  UNIQUE (workspace_id, outbox_event_id),
  CONSTRAINT queue_duplicate_probe_acceptance_request_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

-- Keep the fixture forward-compatible for a developer volume created by an
-- earlier revision of this test-only schema.
ALTER TABLE app.queue_duplicate_probe_acceptances
  ADD COLUMN IF NOT EXISTS request_hash char(64);
UPDATE app.queue_duplicate_probe_acceptances
SET request_hash = repeat('0', 64)
WHERE request_hash IS NULL;
ALTER TABLE app.queue_duplicate_probe_acceptances
  ALTER COLUMN request_hash SET NOT NULL,
  ALTER COLUMN outbox_event_id DROP NOT NULL;
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'queue_duplicate_probe_acceptance_request_hash'
      AND conrelid = 'app.queue_duplicate_probe_acceptances'::regclass
  ) THEN
    ALTER TABLE app.queue_duplicate_probe_acceptances
      ADD CONSTRAINT queue_duplicate_probe_acceptance_request_hash
      CHECK (request_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$constraint$;

DO $fixture$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'queue_duplicate_probe_attempts',
    'queue_duplicate_probe_events',
    'queue_duplicate_probe_usage',
    'queue_duplicate_probe_provider_effects',
    'queue_duplicate_probe_provider_intents',
    'queue_duplicate_probe_acceptances'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS queue_duplicate_probe_workspace_scope ON app.%I',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY queue_duplicate_probe_workspace_scope ON app.%I FOR ALL TO {{api_runtime_role}}, {{worker_runtime_role}} USING (workspace_id::text = NULLIF(current_setting(''app.workspace_id'', true), '''')) WITH CHECK (workspace_id::text = NULLIF(current_setting(''app.workspace_id'', true), ''''))',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON app.%I TO {{api_runtime_role}}, {{worker_runtime_role}}',
      table_name
    );
  END LOOP;
END
$fixture$;
