-- Preview output artifacts are explicitly owned and may never outlive their
-- immutable preview run. The link is separate from artifact metadata so later
-- owner kinds can reuse the lifecycle without polymorphic cascades.

CREATE UNIQUE INDEX artifacts_workspace_identity_unique
  ON app.artifacts (workspace_id, id);

CREATE TABLE app.artifact_links (
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  owner_kind varchar(32) NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT artifact_links_identity_unique
    PRIMARY KEY (workspace_id, artifact_id, owner_kind, owner_id),
  CONSTRAINT artifact_links_artifact_fk
    FOREIGN KEY (workspace_id, artifact_id)
    REFERENCES app.artifacts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifact_links_preview_run_fk
    FOREIGN KEY (workspace_id, owner_id)
    REFERENCES app.preview_runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifact_links_owner_kind_valid
    CHECK (owner_kind = 'preview_run')
);

CREATE INDEX artifact_links_owner_idx
  ON app.artifact_links (workspace_id, owner_kind, owner_id, artifact_id);

CREATE FUNCTION app.enforce_preview_artifact_retention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.artifacts artifact
    JOIN app.preview_runs preview
      ON preview.workspace_id = NEW.workspace_id
     AND preview.id = NEW.owner_id
    WHERE artifact.workspace_id = NEW.workspace_id
      AND artifact.id = NEW.artifact_id
      AND artifact.expires_at <= preview.expires_at
  ) THEN
    RAISE EXCEPTION 'preview artifact retention exceeds its owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER artifact_link_preview_retention
  BEFORE INSERT ON app.artifact_links
  FOR EACH ROW EXECUTE FUNCTION app.enforce_preview_artifact_retention();

ALTER TABLE app.artifact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.artifact_links FORCE ROW LEVEL SECURITY;

CREATE POLICY artifact_links_workspace_scope ON app.artifact_links
  FOR ALL TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  )
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

ALTER TABLE app.artifact_links OWNER TO {{owner_role}};
ALTER FUNCTION app.enforce_preview_artifact_retention() OWNER TO {{owner_role}};

REVOKE ALL ON app.artifact_links
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.enforce_preview_artifact_retention() FROM PUBLIC;

GRANT SELECT ON app.artifact_links TO {{api_runtime_role}};
GRANT SELECT, INSERT ON app.artifact_links TO {{worker_runtime_role}};

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.artifact_links FROM {{api_runtime_role}}, {{dispatcher_role}};
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.artifact_links FROM {{worker_runtime_role}}, {{dispatcher_role}};
