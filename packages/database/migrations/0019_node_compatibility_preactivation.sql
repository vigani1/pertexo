-- A compatibility release may become current only after a deployment names
-- the complete API and worker cohorts and every named artifact has matched the
-- durable target release. Serving roles remain read-only; the deployment
-- controller executes these audited operations through the owner role.

CREATE TABLE app.node_compatibility_preactivation_checks (
  check_id uuid PRIMARY KEY,
  deployment_id varchar(128) NOT NULL,
  epoch integer NOT NULL,
  fingerprint varchar(128) NOT NULL,
  role_kind varchar(16) NOT NULL,
  artifact_id varchar(128) NOT NULL,
  observed_catalog jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT node_compatibility_preactivation_deployment_id CHECK (
    deployment_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  CONSTRAINT node_compatibility_preactivation_role_kind CHECK (
    role_kind IN ('api', 'worker')
  ),
  CONSTRAINT node_compatibility_preactivation_artifact_id CHECK (
    artifact_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  CONSTRAINT node_compatibility_preactivation_release_fk
    FOREIGN KEY (epoch, fingerprint)
    REFERENCES app.node_compatibility_releases(epoch, fingerprint),
  CONSTRAINT node_compatibility_preactivation_unique_artifact
    UNIQUE (deployment_id, epoch, fingerprint, role_kind, artifact_id)
);

CREATE TABLE app.node_compatibility_activation_approvals (
  approval_id uuid PRIMARY KEY,
  deployment_id varchar(128) NOT NULL,
  epoch integer NOT NULL,
  fingerprint varchar(128) NOT NULL,
  required_api_artifacts jsonb NOT NULL,
  required_worker_artifacts jsonb NOT NULL,
  approved_by varchar(128) NOT NULL,
  reason varchar(500) NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT node_compatibility_activation_approvals_deployment_id CHECK (
    deployment_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  CONSTRAINT node_compatibility_activation_approvals_actor CHECK (
    approved_by ~ '^[A-Za-z0-9._:@/-]{1,128}$'
  ),
  CONSTRAINT node_compatibility_activation_approvals_reason CHECK (
    length(btrim(reason)) > 0
  ),
  CONSTRAINT node_compatibility_activation_approvals_release_fk
    FOREIGN KEY (epoch, fingerprint)
    REFERENCES app.node_compatibility_releases(epoch, fingerprint),
  CONSTRAINT node_compatibility_activation_approvals_deployment_unique
    UNIQUE (deployment_id, epoch, fingerprint)
);

CREATE TABLE app.node_compatibility_activations (
  activation_id uuid PRIMARY KEY,
  approval_id uuid NOT NULL UNIQUE,
  predecessor_epoch integer NOT NULL,
  predecessor_fingerprint varchar(128) NOT NULL,
  epoch integer NOT NULL,
  fingerprint varchar(128) NOT NULL,
  activated_by_kind varchar(32) NOT NULL,
  activated_by varchar(128) NOT NULL,
  reason varchar(500) NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT node_compatibility_activations_actor_kind CHECK (
    activated_by_kind IN ('migration', 'deployment')
  ),
  CONSTRAINT node_compatibility_activations_actor CHECK (
    activated_by ~ '^[A-Za-z0-9._:@/-]{1,128}$'
  ),
  CONSTRAINT node_compatibility_activations_reason CHECK (
    length(btrim(reason)) > 0
  ),
  CONSTRAINT node_compatibility_activations_approval_fk
    FOREIGN KEY (approval_id)
    REFERENCES app.node_compatibility_activation_approvals(approval_id),
  CONSTRAINT node_compatibility_activations_predecessor_fk
    FOREIGN KEY (predecessor_epoch, predecessor_fingerprint)
    REFERENCES app.node_compatibility_releases(epoch, fingerprint),
  CONSTRAINT node_compatibility_activations_release_fk
    FOREIGN KEY (epoch, fingerprint)
    REFERENCES app.node_compatibility_releases(epoch, fingerprint)
);

ALTER TABLE app.node_compatibility_current
  ADD COLUMN activation_approval_id uuid,
  ADD CONSTRAINT node_compatibility_current_activation_approval_fk
    FOREIGN KEY (activation_approval_id)
    REFERENCES app.node_compatibility_activation_approvals(approval_id);

CREATE FUNCTION app.node_compatibility_artifact_set_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, app
AS $function$
  SELECT jsonb_typeof(value) = 'array'
     AND jsonb_array_length(value) BETWEEN 1 AND 1000
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(value) AS artifact(element)
        WHERE jsonb_typeof(element) <> 'string'
           OR element #>> '{}' !~ '^[A-Za-z0-9._:-]{1,128}$'
     )
     AND (
       SELECT count(*) = count(DISTINCT element)
         FROM jsonb_array_elements(value) AS artifact(element)
     );
$function$;

ALTER TABLE app.node_compatibility_activation_approvals
  ADD CONSTRAINT node_compatibility_activation_approvals_api_artifacts
    CHECK (app.node_compatibility_artifact_set_valid(required_api_artifacts)),
  ADD CONSTRAINT node_compatibility_activation_approvals_worker_artifacts
    CHECK (app.node_compatibility_artifact_set_valid(required_worker_artifacts));

CREATE FUNCTION app.prepare_node_compatibility_release(
  target_epoch integer,
  target_fingerprint varchar,
  target_catalog jsonb,
  expected_predecessor_epoch integer,
  expected_predecessor_fingerprint varchar,
  actor_kind varchar,
  actor_id varchar,
  preparation_reason varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  current_epoch integer;
  current_fingerprint varchar;
  existing app.node_compatibility_releases%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM app.node_compatibility_releases
   WHERE epoch = target_epoch;
  IF FOUND THEN
    IF existing.fingerprint = target_fingerprint
       AND existing.catalog_json = target_catalog
       AND existing.predecessor_epoch = expected_predecessor_epoch
       AND existing.prepared_by_kind = actor_kind
       AND existing.prepared_by = actor_id
       AND existing.reason = preparation_reason THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'compatibility release preparation conflicts with an existing epoch'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT epoch, fingerprint
    INTO current_epoch, current_fingerprint
    FROM app.node_compatibility_current
   WHERE singleton
   FOR SHARE;

  IF current_epoch IS DISTINCT FROM expected_predecessor_epoch
     OR current_fingerprint IS DISTINCT FROM expected_predecessor_fingerprint
     OR target_epoch <> expected_predecessor_epoch + 1 THEN
    RAISE EXCEPTION 'compatibility release predecessor changed'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.node_compatibility_releases
    (epoch, schema_version, fingerprint, catalog_json, predecessor_epoch,
     prepared_by_kind, prepared_by, reason)
  VALUES
    (target_epoch, 1, target_fingerprint, target_catalog,
     expected_predecessor_epoch, actor_kind, actor_id, preparation_reason);
END;
$function$;

CREATE FUNCTION app.lock_node_compatibility_current_supported(
  supported_releases jsonb
)
RETURNS TABLE(epoch integer, fingerprint varchar, catalog_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF jsonb_typeof(supported_releases) <> 'array'
     OR jsonb_array_length(supported_releases) NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'supported compatibility release set is invalid'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
    SELECT current_release.epoch,
           current_release.fingerprint,
           release.catalog_json
      FROM app.node_compatibility_current AS current_release
      JOIN app.node_compatibility_releases AS release
        ON release.epoch = current_release.epoch
       AND release.fingerprint = current_release.fingerprint
     WHERE current_release.singleton
       AND EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(supported_releases)
                AS supported(epoch integer, fingerprint varchar, catalog jsonb)
          WHERE supported.epoch = current_release.epoch
            AND supported.fingerprint = current_release.fingerprint
            AND supported.catalog = release.catalog_json
       )
     FOR SHARE OF current_release, release;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'node compatibility release does not match this artifact'
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

CREATE FUNCTION app.record_node_compatibility_preactivation(
  preactivation_check_id uuid,
  target_deployment_id varchar,
  target_epoch integer,
  target_fingerprint varchar,
  target_role_kind varchar,
  target_artifact_id varchar,
  target_observed_catalog jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  durable_catalog jsonb;
  existing app.node_compatibility_preactivation_checks%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM app.node_compatibility_preactivation_checks
   WHERE check_id = preactivation_check_id;
  IF FOUND THEN
    IF existing.deployment_id = target_deployment_id
       AND existing.epoch = target_epoch
       AND existing.fingerprint = target_fingerprint
       AND existing.role_kind = target_role_kind
       AND existing.artifact_id = target_artifact_id
       AND existing.observed_catalog = target_observed_catalog THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'compatibility preactivation check conflicts with an existing command'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT catalog_json
    INTO durable_catalog
    FROM app.node_compatibility_releases
   WHERE epoch = target_epoch
     AND fingerprint = target_fingerprint
   FOR SHARE;

  IF durable_catalog IS NULL OR durable_catalog <> target_observed_catalog THEN
    RAISE EXCEPTION 'preactivation target does not match the durable release'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.node_compatibility_preactivation_checks
    (check_id, deployment_id, epoch, fingerprint, role_kind, artifact_id,
     observed_catalog)
  VALUES
    (preactivation_check_id, target_deployment_id, target_epoch,
     target_fingerprint, target_role_kind, target_artifact_id,
     target_observed_catalog);
END;
$function$;

CREATE FUNCTION app.compatibility_preactivation_cohort_complete(
  target_deployment_id varchar,
  target_epoch integer,
  target_fingerprint varchar,
  target_role_kind varchar,
  required_artifacts jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SET search_path = pg_catalog, app
AS $function$
  SELECT app.node_compatibility_artifact_set_valid(required_artifacts)
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(required_artifacts) AS required(artifact_id)
        WHERE NOT EXISTS (
          SELECT 1
            FROM app.node_compatibility_preactivation_checks AS checked
           WHERE checked.deployment_id = target_deployment_id
             AND checked.epoch = target_epoch
             AND checked.fingerprint = target_fingerprint
             AND checked.role_kind = target_role_kind
             AND checked.artifact_id = required.artifact_id
        )
     );
$function$;

CREATE FUNCTION app.approve_node_compatibility_activation(
  target_approval_id uuid,
  target_deployment_id varchar,
  target_epoch integer,
  target_fingerprint varchar,
  target_api_artifacts jsonb,
  target_worker_artifacts jsonb,
  actor_id varchar,
  approval_reason varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  existing app.node_compatibility_activation_approvals%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM app.node_compatibility_activation_approvals
   WHERE approval_id = target_approval_id;
  IF FOUND THEN
    IF existing.deployment_id = target_deployment_id
       AND existing.epoch = target_epoch
       AND existing.fingerprint = target_fingerprint
       AND existing.required_api_artifacts = target_api_artifacts
       AND existing.required_worker_artifacts = target_worker_artifacts
       AND existing.approved_by = actor_id
       AND existing.reason = approval_reason THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'compatibility activation approval conflicts with an existing command'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT app.compatibility_preactivation_cohort_complete(
       target_deployment_id, target_epoch, target_fingerprint, 'api',
       target_api_artifacts
     )
     OR NOT app.compatibility_preactivation_cohort_complete(
       target_deployment_id, target_epoch, target_fingerprint, 'worker',
       target_worker_artifacts
     ) THEN
    RAISE EXCEPTION 'compatibility preactivation cohort is incomplete'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.node_compatibility_activation_approvals
    (approval_id, deployment_id, epoch, fingerprint,
     required_api_artifacts, required_worker_artifacts, approved_by, reason)
  VALUES
    (target_approval_id, target_deployment_id, target_epoch,
     target_fingerprint, target_api_artifacts, target_worker_artifacts,
     actor_id, approval_reason);
END;
$function$;

CREATE FUNCTION app.activate_node_compatibility_release(
  target_activation_id uuid,
  expected_predecessor_epoch integer,
  expected_predecessor_fingerprint varchar,
  target_approval_id uuid,
  actor_kind varchar,
  actor_id varchar,
  activation_reason varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  approval app.node_compatibility_activation_approvals%ROWTYPE;
  current_epoch integer;
  current_fingerprint varchar;
  target_predecessor integer;
  existing app.node_compatibility_activations%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM app.node_compatibility_activations
   WHERE activation_id = target_activation_id;
  IF FOUND THEN
    IF existing.approval_id = target_approval_id
       AND existing.predecessor_epoch = expected_predecessor_epoch
       AND existing.predecessor_fingerprint = expected_predecessor_fingerprint
       AND existing.activated_by_kind = actor_kind
       AND existing.activated_by = actor_id
       AND existing.reason = activation_reason THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'compatibility activation conflicts with an existing command'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT epoch, fingerprint
    INTO current_epoch, current_fingerprint
    FROM app.node_compatibility_current
   WHERE singleton
   FOR UPDATE;

  IF current_epoch IS DISTINCT FROM expected_predecessor_epoch
     OR current_fingerprint IS DISTINCT FROM expected_predecessor_fingerprint THEN
    RAISE EXCEPTION 'compatibility activation predecessor changed'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO approval
    FROM app.node_compatibility_activation_approvals
   WHERE approval_id = target_approval_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'compatibility activation approval is missing'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT predecessor_epoch INTO target_predecessor
    FROM app.node_compatibility_releases
   WHERE epoch = approval.epoch
     AND fingerprint = approval.fingerprint
   FOR SHARE;
  IF target_predecessor IS DISTINCT FROM current_epoch
     OR NOT app.compatibility_preactivation_cohort_complete(
       approval.deployment_id, approval.epoch, approval.fingerprint, 'api',
       approval.required_api_artifacts
     )
     OR NOT app.compatibility_preactivation_cohort_complete(
       approval.deployment_id, approval.epoch, approval.fingerprint, 'worker',
       approval.required_worker_artifacts
     ) THEN
    RAISE EXCEPTION 'compatibility activation approval is stale'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.node_compatibility_activations
    (activation_id, approval_id, predecessor_epoch, predecessor_fingerprint,
     epoch, fingerprint, activated_by_kind, activated_by, reason)
  VALUES
    (target_activation_id, approval.approval_id, current_epoch,
     current_fingerprint, approval.epoch, approval.fingerprint, actor_kind,
     actor_id, activation_reason);

  UPDATE app.node_compatibility_current
     SET epoch = approval.epoch,
         fingerprint = approval.fingerprint,
         activated_by_kind = actor_kind,
         activated_by = actor_id,
         activated_at = transaction_timestamp(),
         activation_approval_id = approval.approval_id
   WHERE singleton;
END;
$function$;

CREATE TRIGGER node_compatibility_preactivation_checks_immutable
BEFORE UPDATE OR DELETE ON app.node_compatibility_preactivation_checks
FOR EACH ROW EXECUTE FUNCTION app.reject_node_compatibility_release_change();

CREATE TRIGGER node_compatibility_activation_approvals_immutable
BEFORE UPDATE OR DELETE ON app.node_compatibility_activation_approvals
FOR EACH ROW EXECUTE FUNCTION app.reject_node_compatibility_release_change();

CREATE TRIGGER node_compatibility_activations_immutable
BEFORE UPDATE OR DELETE ON app.node_compatibility_activations
FOR EACH ROW EXECUTE FUNCTION app.reject_node_compatibility_release_change();

ALTER TABLE app.node_compatibility_preactivation_checks OWNER TO {{owner_role}};
ALTER TABLE app.node_compatibility_activation_approvals OWNER TO {{owner_role}};
ALTER TABLE app.node_compatibility_activations OWNER TO {{owner_role}};
ALTER FUNCTION app.node_compatibility_artifact_set_valid(jsonb) OWNER TO {{owner_role}};
ALTER FUNCTION app.lock_node_compatibility_current_supported(jsonb) OWNER TO {{owner_role}};
ALTER FUNCTION app.prepare_node_compatibility_release(integer, varchar, jsonb, integer, varchar, varchar, varchar, varchar) OWNER TO {{owner_role}};
ALTER FUNCTION app.record_node_compatibility_preactivation(uuid, varchar, integer, varchar, varchar, varchar, jsonb) OWNER TO {{owner_role}};
ALTER FUNCTION app.compatibility_preactivation_cohort_complete(varchar, integer, varchar, varchar, jsonb) OWNER TO {{owner_role}};
ALTER FUNCTION app.approve_node_compatibility_activation(uuid, varchar, integer, varchar, jsonb, jsonb, varchar, varchar) OWNER TO {{owner_role}};
ALTER FUNCTION app.activate_node_compatibility_release(uuid, integer, varchar, uuid, varchar, varchar, varchar) OWNER TO {{owner_role}};

REVOKE ALL ON app.node_compatibility_preactivation_checks,
  app.node_compatibility_activation_approvals,
  app.node_compatibility_activations FROM PUBLIC;
REVOKE ALL ON FUNCTION app.node_compatibility_artifact_set_valid(jsonb),
  app.lock_node_compatibility_current_supported(jsonb),
  app.prepare_node_compatibility_release(integer, varchar, jsonb, integer, varchar, varchar, varchar, varchar),
  app.record_node_compatibility_preactivation(uuid, varchar, integer, varchar, varchar, varchar, jsonb),
  app.compatibility_preactivation_cohort_complete(varchar, integer, varchar, varchar, jsonb),
  app.approve_node_compatibility_activation(uuid, varchar, integer, varchar, jsonb, jsonb, varchar, varchar),
  app.activate_node_compatibility_release(uuid, integer, varchar, uuid, varchar, varchar, varchar)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.lock_node_compatibility_current_supported(jsonb)
  TO {{api_runtime_role}}, {{worker_runtime_role}};

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.node_compatibility_preactivation_checks,
     app.node_compatibility_activation_approvals,
     app.node_compatibility_activations
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
