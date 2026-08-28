CREATE TABLE app.regional_write_admission (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enforced boolean NOT NULL,
  expected_replica_application_name varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('open','paused','unavailable')),
  replay_lag_millis bigint CHECK (replay_lag_millis IS NULL OR replay_lag_millis>=0),
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (enforced OR status='open')
);

ALTER TABLE app.regional_write_admission OWNER TO {{owner_role}};
REVOKE ALL ON app.regional_write_admission FROM PUBLIC;

INSERT INTO app.regional_write_admission (
  singleton,enforced,expected_replica_application_name,status
) VALUES (
  true,{{regional_write_admission_enforced}},'pertexo-eu-west-1',
  CASE WHEN {{regional_write_admission_enforced}} THEN 'unavailable' ELSE 'open' END
);

CREATE FUNCTION app.record_regional_replica_lag(
  p_application_name varchar,
  p_replication_state varchar,
  p_replay_lag_millis bigint
) RETURNS varchar LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  admission app.regional_write_admission%ROWTYPE;
  next_status varchar;
BEGIN
  SELECT * INTO admission FROM app.regional_write_admission
  WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'regional write admission state missing';
  END IF;
  IF p_application_name IS DISTINCT FROM admission.expected_replica_application_name THEN
    RAISE EXCEPTION 'unexpected regional replica identity';
  END IF;
  IF NOT admission.enforced THEN
    RETURN admission.status;
  END IF;
  next_status:=CASE
    WHEN p_replication_state='streaming' AND p_replay_lag_millis IS NOT NULL
      AND p_replay_lag_millis<300000 THEN 'open'
    WHEN p_replication_state='streaming' AND p_replay_lag_millis IS NOT NULL
      THEN 'paused'
    ELSE 'unavailable'
  END;
  UPDATE app.regional_write_admission
  SET status=next_status,replay_lag_millis=p_replay_lag_millis,
      observed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE singleton;
  RETURN next_status;
END $$;

CREATE FUNCTION app.assert_regional_write_admission()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE admission app.regional_write_admission%ROWTYPE;
BEGIN
  SELECT * INTO admission FROM app.regional_write_admission WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'regional write admission state missing' USING ERRCODE='PTA03';
  END IF;
  IF admission.enforced AND (
    admission.status<>'open' OR admission.observed_at IS NULL OR
    admission.observed_at<now()-interval '15 seconds'
  ) THEN
    RAISE EXCEPTION 'regional.write_admission_paused' USING ERRCODE='PTA03';
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assert_regional_write_admission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint)
  TO {{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.assert_regional_write_admission()
  TO {{api_runtime_role}},{{worker_runtime_role}},{{maintenance_role}},{{operator_role}};
