-- OIDC login starts are unauthenticated, so admission and retention must be
-- enforced at the durable boundary. The trigger serializes its short
-- prune/count/insert decision across every API instance. Runtime callers do
-- not receive DELETE or direct function execution privileges.

CREATE INDEX oidc_login_transactions_consumed_idx
  ON app.oidc_login_transactions (consumed_at, state_digest)
  WHERE consumed_at IS NOT NULL;

CREATE FUNCTION app.enforce_oidc_login_transaction_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $capacity$
DECLARE
  admission_time timestamptz := clock_timestamp();
  active_count bigint;
  total_count bigint;
BEGIN
  -- A transaction-scoped lock makes pruning and both capacity decisions
  -- atomic across processes while releasing automatically on every outcome.
  PERFORM pg_advisory_xact_lock(7166118815);

  -- Keep cleanup bounded so a long-idle installation resumes incrementally
  -- instead of turning the first login into an unbounded maintenance query.
  DELETE FROM app.oidc_login_transactions AS transaction
  WHERE transaction.ctid IN (
    SELECT stale.ctid
    FROM app.oidc_login_transactions AS stale
    WHERE
      stale.expires_at <= admission_time - interval '15 minutes'
      OR stale.consumed_at <= admission_time - interval '15 minutes'
    ORDER BY coalesce(stale.consumed_at, stale.expires_at), stale.state_digest
    LIMIT 1000
  );

  SELECT count(*)
  INTO active_count
  FROM app.oidc_login_transactions AS transaction
  WHERE transaction.consumed_at IS NULL
    AND transaction.expires_at > admission_time;

  IF active_count >= 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'OIDC login transaction capacity is exhausted';
  END IF;

  SELECT count(*)
  INTO total_count
  FROM app.oidc_login_transactions;

  IF total_count >= 20000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '54000',
      MESSAGE = 'OIDC login transaction retention capacity is exhausted';
  END IF;

  RETURN NEW;
END;
$capacity$;

REVOKE ALL ON FUNCTION app.enforce_oidc_login_transaction_capacity()
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

CREATE TRIGGER oidc_login_transactions_capacity
BEFORE INSERT ON app.oidc_login_transactions
FOR EACH ROW
EXECUTE FUNCTION app.enforce_oidc_login_transaction_capacity();

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.oidc_login_transactions
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
