-- Phase 3 adds an immutable executable projection beside the retained Phase 2
-- authoring graph. Existing wf:v1 rows remain readable but non-executable.

ALTER TABLE app.workflow_versions
  ADD COLUMN executable_schema_version integer,
  ADD COLUMN executable_json jsonb,
  ADD COLUMN compatibility_release_epoch integer;

ALTER TABLE app.workflow_versions
  DROP CONSTRAINT workflow_versions_checksum_format,
  ADD CONSTRAINT workflow_versions_checksum_format CHECK ((
    (
      checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$'
      AND executable_schema_version IS NULL
      AND executable_json IS NULL
      AND compatibility_release_epoch IS NULL
    )
    OR
    (
      checksum ~ '^wf:v2:sha256:[0-9a-f]{64}$'
      AND executable_schema_version IS NOT NULL
      AND executable_schema_version = 2
      AND executable_json IS NOT NULL
      AND jsonb_typeof(executable_json) = 'object'
      AND compatibility_release_epoch IS NOT NULL
      AND compatibility_release_epoch > 0
    )
  ) IS TRUE
  ),
  ADD CONSTRAINT workflow_versions_executable_bounded CHECK (
    executable_json IS NULL
    OR octet_length(executable_json::text) <= 1048576
  );

CREATE POLICY workflow_versions_worker_execution_read
  ON app.workflow_versions
  FOR SELECT TO {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
    AND checksum LIKE 'wf:v2:sha256:%'
    AND executable_schema_version = 2
    AND executable_json IS NOT NULL
    AND compatibility_release_epoch > 0
  );

REVOKE ALL ON app.workflow_versions FROM {{worker_runtime_role}};
GRANT SELECT (
  id, workspace_id, workflow_id, version_number, schema_version,
  checksum, executable_schema_version, executable_json,
  compatibility_release_epoch
) ON app.workflow_versions TO {{worker_runtime_role}};
