-- ADR 010 keeps every Phase 3 executor deployable until the later audited
-- retirement control plane exists. Future additive catalogs may add identities,
-- but they cannot omit, duplicate, stage, block, or retire the three core
-- executors released by Phase 3.

CREATE FUNCTION app.enforce_phase3_core_executor_non_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  required record;
  matching_identity_count integer;
  matching_serving_count integer;
BEGIN
  IF jsonb_typeof(NEW.catalog_json->'executors') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'compatibility release must retain the Phase 3 core executors'
      USING ERRCODE = '23514';
  END IF;

  FOR required IN
    SELECT identity.key, identity.version
      FROM (VALUES
        ('core.manual', 1),
        ('core.set', 1),
        ('core.terminate', 1)
      ) AS identity(key, version)
  LOOP
    SELECT count(*),
           count(*) FILTER (
             WHERE executor->>'lifecycle' IN ('active', 'retained')
           )
      INTO matching_identity_count, matching_serving_count
      FROM jsonb_array_elements(NEW.catalog_json->'executors') AS executor
     WHERE executor#>>'{executor,key}' = required.key
       AND executor#>>'{executor,version}' = required.version::text;

    IF matching_identity_count <> 1 OR matching_serving_count <> 1 THEN
      RAISE EXCEPTION 'compatibility release must retain core executor %', required.key
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app.enforce_phase3_core_executor_non_removal() FROM PUBLIC;

CREATE TRIGGER node_compatibility_releases_phase3_core_non_removal
BEFORE INSERT ON app.node_compatibility_releases
FOR EACH ROW EXECUTE FUNCTION app.enforce_phase3_core_executor_non_removal();

ALTER FUNCTION app.enforce_phase3_core_executor_non_removal() OWNER TO {{owner_role}};
