-- Refresh the OIDC admission timestamp only after the serialized capacity
-- decision acquires its transaction-scoped lock. A transaction that waited for
-- the lock must not count another transaction that expired during that wait.

CREATE OR REPLACE FUNCTION app.enforce_oidc_login_transaction_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $capacity$
DECLARE
  admission_time timestamptz;
  active_count bigint;
  total_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7166118815);
  admission_time := clock_timestamp();

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
