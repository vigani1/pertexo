-- Make regional replica admission fail closed unless one deployment-owned
-- identity is observed. Physical replication slots are an infrastructure
-- option, not a database-schema prerequisite; application_name remains bound
-- to the expected deployment identity and its observed cardinality is durable.

ALTER TABLE app.regional_write_admission
  ADD COLUMN replica_identity_status varchar(16) NOT NULL DEFAULT 'missing',
  ADD COLUMN replica_session_count integer NOT NULL DEFAULT 0;

ALTER TABLE app.regional_write_admission
  ADD CONSTRAINT regional_write_admission_replica_identity_status_check
    CHECK (replica_identity_status IN ('unique','missing','duplicate')),
  ADD CONSTRAINT regional_write_admission_replica_session_count_check
    CHECK (replica_session_count >= 0);

-- A rollout cannot trust an old open observation until the new cardinality
-- check has run at least once.
UPDATE app.regional_write_admission
SET replica_identity_status='missing',
    replica_session_count=0,
    status=CASE WHEN enforced THEN 'unavailable' ELSE 'open' END,
    replay_lag_millis=NULL,
    observed_at=NULL,
    updated_at=clock_timestamp();

DROP FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint);

CREATE FUNCTION app.record_regional_replica_lag(
  p_application_name varchar,
  p_replication_state varchar,
  p_replay_lag_millis bigint,
  p_session_count integer
) RETURNS varchar LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  admission app.regional_write_admission%ROWTYPE;
  next_identity_status varchar;
  next_status varchar;
  next_lag_millis bigint;
BEGIN
  IF p_session_count IS NULL OR p_session_count < 0 THEN
    RAISE EXCEPTION 'regional replica session count is invalid';
  END IF;
  IF p_replay_lag_millis IS NOT NULL AND p_replay_lag_millis < 0 THEN
    RAISE EXCEPTION 'regional replica replay lag is invalid';
  END IF;

  SELECT * INTO admission FROM app.regional_write_admission
  WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'regional write admission state missing';
  END IF;
  IF p_application_name IS DISTINCT FROM admission.expected_replica_application_name THEN
    RAISE EXCEPTION 'unexpected regional replica identity';
  END IF;

  next_identity_status:=CASE
    WHEN p_session_count=1 THEN 'unique'
    WHEN p_session_count=0 THEN 'missing'
    ELSE 'duplicate'
  END;
  next_lag_millis:=CASE WHEN p_session_count=1 THEN p_replay_lag_millis ELSE NULL END;
  next_status:=CASE
    WHEN NOT admission.enforced THEN 'open'
    WHEN p_session_count<>1 THEN 'unavailable'
    WHEN p_replication_state='streaming' AND next_lag_millis IS NOT NULL
      AND next_lag_millis<300000 THEN 'open'
    WHEN p_replication_state='streaming' AND next_lag_millis IS NOT NULL
      THEN 'paused'
    ELSE 'unavailable'
  END;

  UPDATE app.regional_write_admission
  SET status=next_status,
      replica_identity_status=next_identity_status,
      replica_session_count=p_session_count,
      replay_lag_millis=next_lag_millis,
      observed_at=clock_timestamp(),
      updated_at=clock_timestamp()
  WHERE singleton;
  RETURN next_status;
END $$;

REVOKE ALL ON FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint,integer)
  TO {{maintenance_role}};
