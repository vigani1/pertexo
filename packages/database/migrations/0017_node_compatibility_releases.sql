-- ADR 010 makes compatibility state PostgreSQL-authoritative before any
-- serving process may publish or admit a V2 workflow. Phase 3 has one initial
-- additive release; later audited maintenance may append releases and move the
-- singleton pointer, but serving roles can only read this authority.

CREATE TABLE app.node_compatibility_releases (
  epoch integer PRIMARY KEY,
  schema_version integer NOT NULL,
  fingerprint varchar(128) NOT NULL,
  catalog_json jsonb NOT NULL,
  predecessor_epoch integer,
  prepared_by_kind varchar(32) NOT NULL,
  prepared_by varchar(128) NOT NULL,
  reason varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT node_compatibility_releases_schema_version CHECK (schema_version = 1),
  CONSTRAINT node_compatibility_releases_epoch_positive CHECK (epoch > 0),
  CONSTRAINT node_compatibility_releases_fingerprint_format CHECK (
    fingerprint ~ '^node-compat:v1:sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT node_compatibility_releases_catalog_object CHECK (
    jsonb_typeof(catalog_json) = 'object'
    AND catalog_json->>'domain' = 'pertexo.node-compatibility-release'
    AND catalog_json->>'schemaVersion' = '1'
  ),
  CONSTRAINT node_compatibility_releases_predecessor_order CHECK (
    predecessor_epoch IS NULL OR predecessor_epoch < epoch
  ),
  CONSTRAINT node_compatibility_releases_prepared_by_kind CHECK (
    prepared_by_kind IN ('migration', 'deployment')
  ),
  CONSTRAINT node_compatibility_releases_predecessor_fk
    FOREIGN KEY (predecessor_epoch)
    REFERENCES app.node_compatibility_releases(epoch),
  CONSTRAINT node_compatibility_releases_epoch_fingerprint_unique
    UNIQUE (epoch, fingerprint)
);

CREATE TABLE app.node_compatibility_current (
  singleton boolean PRIMARY KEY DEFAULT true,
  epoch integer NOT NULL,
  fingerprint varchar(128) NOT NULL,
  activated_by_kind varchar(32) NOT NULL,
  activated_by varchar(128) NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT node_compatibility_current_singleton CHECK (singleton),
  CONSTRAINT node_compatibility_current_epoch_positive CHECK (epoch > 0),
  CONSTRAINT node_compatibility_current_fingerprint_format CHECK (
    fingerprint ~ '^node-compat:v1:sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT node_compatibility_current_activated_by_kind CHECK (
    activated_by_kind IN ('migration', 'deployment')
  ),
  CONSTRAINT node_compatibility_current_release_fk
    FOREIGN KEY (epoch, fingerprint)
    REFERENCES app.node_compatibility_releases(epoch, fingerprint)
);

CREATE FUNCTION app.reject_node_compatibility_release_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  RAISE EXCEPTION 'node compatibility releases are immutable'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION app.reject_node_compatibility_release_change() FROM PUBLIC;

CREATE TRIGGER node_compatibility_releases_immutable
BEFORE UPDATE OR DELETE ON app.node_compatibility_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_node_compatibility_release_change();

CREATE FUNCTION app.lock_node_compatibility_current(
  expected_epoch integer,
  expected_fingerprint varchar,
  expected_catalog jsonb
)
RETURNS TABLE(epoch integer, fingerprint varchar, catalog_json jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  RETURN QUERY
    SELECT current_release.epoch,
           current_release.fingerprint,
           release.catalog_json
      FROM app.node_compatibility_current AS current_release
      JOIN app.node_compatibility_releases AS release
        ON release.epoch = current_release.epoch
       AND release.fingerprint = current_release.fingerprint
     WHERE current_release.singleton
       AND current_release.epoch = expected_epoch
       AND current_release.fingerprint = expected_fingerprint
       AND release.catalog_json = expected_catalog
     FOR SHARE OF current_release, release;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'node compatibility release does not match this artifact'
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION app.lock_node_compatibility_current(integer, varchar, jsonb) FROM PUBLIC;

INSERT INTO app.node_compatibility_releases
  (epoch, schema_version, fingerprint, catalog_json, predecessor_epoch,
   prepared_by_kind, prepared_by, reason)
VALUES
  (
    1,
    1,
    'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
    $catalog$
    {
      "domain": "pertexo.node-compatibility-release",
      "schemaVersion": 1,
      "definitions": [
        {
          "schemaVersion": 1,
          "definition": {"key": "core.manual", "version": 1},
          "family": "trigger",
          "configVersion": 1,
          "configSchema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": false, "properties": {}, "type": "object"},
          "inputSchema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}, {"items": {"$ref": "#"}, "type": "array"}, {"additionalProperties": {"$ref": "#"}, "propertyNames": {"type": "string"}, "type": "object"}], "x-pertexo-node-json-limits": {"bytes": 1048576, "depth": 64, "members": 10000}},
          "outputSchema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}, {"items": {"$ref": "#"}, "type": "array"}, {"additionalProperties": {"$ref": "#"}, "propertyNames": {"type": "string"}, "type": "object"}], "x-pertexo-node-json-limits": {"bytes": 1048576, "depth": 64, "members": 10000}},
          "ports": {"inputs": [], "outputs": ["out"]},
          "credentialRequirements": [],
          "connectionRequirements": [],
          "retryClass": "safe",
          "resourceClass": "cpu",
          "capabilities": ["manual"],
          "lifecycle": "active",
          "executor": {"key": "core.manual", "version": 1},
          "executorAbi": 1,
          "policyReferences": [{"key": "node.json.bounded", "version": 1}]
        },
        {
          "schemaVersion": 1,
          "definition": {"key": "core.set", "version": 1},
          "family": "transform",
          "configVersion": 1,
          "configSchema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": false, "properties": {}, "type": "object"},
          "inputSchema": {"$defs": {"__schema0": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}, {"items": {"$ref": "#/$defs/__schema0"}, "type": "array"}, {"additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object"}]}}, "$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object", "x-pertexo-node-json-limits": {"bytes": 1048576, "depth": 64, "members": 10000}},
          "outputSchema": {"$defs": {"__schema0": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}, {"items": {"$ref": "#/$defs/__schema0"}, "type": "array"}, {"additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object"}]}}, "$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object", "x-pertexo-node-json-limits": {"bytes": 1048576, "depth": 64, "members": 10000}},
          "ports": {"inputs": ["in"], "outputs": ["out"]},
          "credentialRequirements": [],
          "connectionRequirements": [],
          "retryClass": "safe",
          "resourceClass": "cpu",
          "capabilities": [],
          "lifecycle": "active",
          "executor": {"key": "core.set", "version": 1},
          "executorAbi": 1,
          "policyReferences": [{"key": "jsonata.restricted", "version": 1}, {"key": "node.json.bounded", "version": 1}]
        },
        {
          "schemaVersion": 1,
          "definition": {"key": "core.terminate", "version": 1},
          "family": "output",
          "configVersion": 1,
          "configSchema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": false, "properties": {}, "type": "object"},
          "inputSchema": {"$defs": {"__schema0": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}, {"items": {"$ref": "#/$defs/__schema0"}, "type": "array"}, {"additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object"}]}}, "$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object", "x-pertexo-node-json-limits": {"bytes": 1048576, "depth": 64, "members": 10000}},
          "outputSchema": {"$defs": {"__schema0": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, {"type": "null"}, {"items": {"$ref": "#/$defs/__schema0"}, "type": "array"}, {"additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object"}]}}, "$schema": "https://json-schema.org/draft/2020-12/schema", "additionalProperties": {"$ref": "#/$defs/__schema0"}, "propertyNames": {"type": "string"}, "type": "object", "x-pertexo-node-json-limits": {"bytes": 1048576, "depth": 64, "members": 10000}},
          "ports": {"inputs": ["in"], "outputs": []},
          "credentialRequirements": [],
          "connectionRequirements": [],
          "retryClass": "safe",
          "resourceClass": "cpu",
          "capabilities": ["terminates_run"],
          "lifecycle": "active",
          "executor": {"key": "core.terminate", "version": 1},
          "executorAbi": 1,
          "policyReferences": [{"key": "node.json.bounded", "version": 1}]
        }
      ],
      "executors": [
        {"executor": {"key": "core.manual", "version": 1}, "abiVersion": 1, "definitions": [{"key": "core.manual", "version": 1}], "lifecycle": "active", "policyReferences": [{"key": "node.json.bounded", "version": 1}]},
        {"executor": {"key": "core.set", "version": 1}, "abiVersion": 1, "definitions": [{"key": "core.set", "version": 1}], "lifecycle": "active", "policyReferences": [{"key": "jsonata.restricted", "version": 1}, {"key": "node.json.bounded", "version": 1}]},
        {"executor": {"key": "core.terminate", "version": 1}, "abiVersion": 1, "definitions": [{"key": "core.terminate", "version": 1}], "lifecycle": "active", "policyReferences": [{"key": "node.json.bounded", "version": 1}]}
      ],
      "policies": [
        {"key": "engine.cancellation", "version": 1},
        {"key": "engine.checkpoint", "version": 1},
        {"key": "engine.retry", "version": 1},
        {"key": "engine.scheduler", "version": 1},
        {"key": "engine.timeout", "version": 1},
        {"key": "jsonata.restricted", "version": 1},
        {"key": "node.json.bounded", "version": 1}
      ]
    }
    $catalog$::jsonb,
    NULL,
    'migration',
    '0017_node_compatibility_releases',
    'Bootstrap the reviewed Phase 3 additive compatibility release'
  );

INSERT INTO app.node_compatibility_current
  (singleton, epoch, fingerprint, activated_by_kind, activated_by)
VALUES
  (
    true,
    1,
    'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
    'migration',
    '0017_node_compatibility_releases'
  );

ALTER TABLE app.node_compatibility_releases OWNER TO {{owner_role}};
ALTER TABLE app.node_compatibility_current OWNER TO {{owner_role}};
ALTER FUNCTION app.reject_node_compatibility_release_change() OWNER TO {{owner_role}};
ALTER FUNCTION app.lock_node_compatibility_current(integer, varchar, jsonb) OWNER TO {{owner_role}};

REVOKE ALL ON app.node_compatibility_releases, app.node_compatibility_current FROM PUBLIC;
GRANT SELECT ON app.node_compatibility_releases, app.node_compatibility_current TO {{api_runtime_role}}, {{worker_runtime_role}};
GRANT EXECUTE ON FUNCTION app.lock_node_compatibility_current(integer, varchar, jsonb) TO {{api_runtime_role}}, {{worker_runtime_role}};
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.node_compatibility_releases, app.node_compatibility_current
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
