-- F08 FRESH REVIEW CANDIDATE, NOT A REGISTERED MIGRATION.
-- Grounded in registered migrations through 0136_workflow_draft_graph_v2.sql.
-- Never derived from, registered alongside, or applied with quarantined 0136.
-- Native writers/catalog/execution remain OFF. No SQL qualification claimed.
-- The guard is deliberately retained while protected writers/readers, Call
-- journal binding, publication authority, retention/purge and readiness are
-- assembled and reviewed. Removing it requires exact installation approval.
DO $$ BEGIN
  RAISE EXCEPTION 'Unregistered F08 0137 review candidate: installation is not authorized';
END $$;

-- Additive native format/trigger shape only. This is NOT semantic publication
-- admission: the actual model/compiler owner and adversarial format/writer
-- barrier qualification remain mandatory before any installation/enablement.
ALTER TABLE app.workflow_versions DROP CONSTRAINT workflow_versions_checksum_format;
ALTER TABLE app.workflow_versions ADD CONSTRAINT workflow_versions_checksum_format CHECK ((
  (checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$' AND executable_schema_version IS NULL
    AND executable_json IS NULL AND compatibility_release_epoch IS NULL)
  OR (checksum ~ '^wf:v2:sha256:[0-9a-f]{64}$' AND executable_schema_version=2
    AND jsonb_typeof(executable_json)='object' AND compatibility_release_epoch>0)
  OR (checksum ~ '^wf:v3:sha256:[0-9a-f]{64}$' AND schema_version=2 AND executable_schema_version=3
    AND jsonb_typeof(executable_json)='object' AND compatibility_release_epoch>0)
) IS TRUE);
-- The registered 0012 published-version constraint is independent of drafts.
-- Widen only the paired native published format; retained v1/v2 remain Graph1.
ALTER TABLE app.workflow_versions DROP CONSTRAINT workflow_versions_schema_version_supported;
ALTER TABLE app.workflow_versions ADD CONSTRAINT workflow_versions_schema_version_supported CHECK ((
  schema_version=1
  OR (schema_version=2 AND graph_json->'schemaVersion'='2'::jsonb
    AND checksum ~ '^wf:v3:sha256:[0-9a-f]{64}$' AND executable_schema_version=3
    AND executable_json->'schemaVersion'='3'::jsonb
    AND jsonb_typeof(executable_json->'graph')='object'
    AND (graph_json->'callable') IS NOT DISTINCT FROM (executable_json#>'{graph,callable}')
    AND compatibility_release_epoch>0)
) IS TRUE);
ALTER POLICY workflow_versions_worker_execution_read ON app.workflow_versions USING (
  workspace_id::text=nullif(current_setting('app.workspace_id',true),'') AND compatibility_release_epoch>0
  AND executable_json IS NOT NULL AND (
    (checksum LIKE 'wf:v2:sha256:%' AND executable_schema_version=2)
    OR (checksum LIKE 'wf:v3:sha256:%' AND schema_version=2 AND executable_schema_version=3)
  )
);
ALTER TABLE app.workflow_runs DROP CONSTRAINT workflow_runs_trigger_type_valid;
ALTER TABLE app.workflow_runs ADD CONSTRAINT workflow_runs_trigger_type_valid
  CHECK(trigger_type IN ('api','manual','replay','schedule','webhook','workflow_call'));

-- Durable human-root initiation lives on the EXISTING run, not in an
-- idempotency scope, publisher session or a new authorization ledger. Only the
-- minimum manual native ingress is implemented here; other native root ingress
-- is denied until its actual admitted-trigger/current-human owner is integrated.
ALTER TABLE app.workflow_runs
  ADD COLUMN native_initiating_actor_id uuid,
  ADD COLUMN native_initiating_role_revision integer,
  ADD CONSTRAINT native_run_initiation_pair CHECK ((
    (native_initiating_actor_id IS NULL AND native_initiating_role_revision IS NULL)
    OR (native_initiating_actor_id IS NOT NULL AND native_initiating_role_revision>0)
  ) IS TRUE);
-- No users FK: retained accepted work must survive removal of its initiator.
-- A missing current user/membership later refuses a FRESH child, not settlement.
CREATE FUNCTION app.capture_native_run_initiation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_actor uuid; v_revision integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.native_initiating_actor_id,NEW.native_initiating_role_revision)
      IS DISTINCT FROM ROW(OLD.native_initiating_actor_id,OLD.native_initiating_role_revision) THEN
      RAISE EXCEPTION 'native run initiation is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.native_initiating_actor_id IS NOT NULL OR NEW.native_initiating_role_revision IS NOT NULL THEN
    RAISE EXCEPTION 'native run initiation is owner-derived' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_versions version
    WHERE version.workspace_id=NEW.workspace_id AND version.workflow_id=NEW.workflow_id
      AND version.id=NEW.workflow_version_id AND version.schema_version=2
      AND version.executable_schema_version=3) OR NEW.trigger_type='workflow_call' THEN
    RETURN NEW;
  END IF;
  IF NEW.trigger_type<>'manual' OR NEW.status<>'queued' THEN
    RAISE EXCEPTION 'native root ingress owner is unavailable' USING ERRCODE='55000';
  END IF;
  IF NEW.workspace_id::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'native root workspace context differs' USING ERRCODE='42501';
  END IF;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'native root initiating actor is unavailable' USING ERRCODE='55000';
  END IF;
  -- BEFORE the existing admission trigger/counter. The actual manual command
  -- has already locked workspace/user/membership in this order. These are real
  -- row checks, not the existing manual-writer GUC treated as proof.
  PERFORM 1 FROM app.workspaces WHERE id=NEW.workspace_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native root workspace is inactive' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.users WHERE id=v_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native root actor is inactive' USING ERRCODE='55000'; END IF;
  SELECT role_revision INTO v_revision FROM app.workspace_memberships membership
    WHERE membership.workspace_id=NEW.workspace_id AND membership.user_id=v_actor
      AND membership.status='active' AND membership.role IN ('owner','admin','builder','operator') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native root membership cannot start runs' USING ERRCODE='55000'; END IF;
  NEW.native_initiating_actor_id:=v_actor;
  NEW.native_initiating_role_revision:=v_revision;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_native_run_initiation()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE TRIGGER aa_native_run_initiation BEFORE INSERT OR UPDATE ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.capture_native_run_initiation();

-- Private numeric comparison primitive for the actual native inline ingress
-- guard below; not a serializer, content identity or publication attestation.
-- PostgreSQL's float8 input supplies finite binary64 rounding. Its zero-result
-- underflow error is mapped to JS zero ONLY at/below the EXACT halfway point
-- between zero and the least positive binary64 subnormal (2^-1075, ties-to-even).
-- The decimal constant is exact: 5^1075 * 10^-1075. Overflow and numeric input
-- outside PostgreSQL's supported numeric range fail operationally, not clamp.
-- Platform differential qualification remains REQUIRED; no SQL was executed.
CREATE FUNCTION app.native_execution_value_binary64_leaf(p_leaf text)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path=pg_catalog,app,pg_temp AS $$
DECLARE
  v_value double precision;
  v_half_subnormal constant numeric:=
    2.4703282292062327208828439643411068618252990130716238221279284125033775363510437593264991818081799618989828234772285886546332835517796989819938739800539093906315035659515570226392290858392449105184435931802849936536152500319370457678249219365623669863658480757001585769269903706311928279558551332927834338409351978015531246597263579574622766465272827220056374006485499977096599470454020828166226237857393450736339007967761930577506740176324673600968951340535537458516661134223766678604162159680461914467291840300530057530849048765391711386591646239524912623653881879636239373280423891018672348497668235089863388587925628302755995657524455507255189313690836254779186948667994968324049705821028513185451396213837722826145437693412532098591327667236328125e-324;
BEGIN
  BEGIN
    v_value:=p_leaf::double precision;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    IF abs(p_leaf::numeric)<=v_half_subnormal THEN RETURN 0::double precision; END IF;
    RAISE;
  END;
  IF v_value IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN
    RAISE EXCEPTION 'native execution numeric value is not finite' USING ERRCODE='22003';
  END IF;
  IF v_value=0 THEN RETURN 0::double precision; END IF;
  RETURN v_value;
END $$;
REVOKE ALL ON FUNCTION app.native_execution_value_binary64_leaf(text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Byte-preserving native inline ingress. Original text is validated with PG18's
-- unique-key predicate BEFORE any JSONB conversion. Traversal uses json for the
-- original, preserving numeric tokens; the already normalized reference is
-- checked per leaf. No jsonb numeric equality, rounding back to numeric, SQL JS
-- encoder or caller-provided semantic-validation label is used.
CREATE FUNCTION app.assert_native_inline_execution_value_bytes(
  p_value jsonb,p_sha256 text,p_byte_length integer,p_original text
) RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $$
DECLARE
  v_original_stack json[];
  v_reference_stack jsonb[];
  v_depth_stack integer[];
  v_original json;
  v_reference jsonb;
  v_type text;
  v_depth integer;
  v_index integer;
  v_members integer:=0;
  v_children integer;
  v_child record;
BEGIN
  IF p_value IS NULL OR p_original IS NULL OR p_sha256 IS NULL
    OR p_sha256!~'^[0-9a-f]{64}$'
    OR p_byte_length IS NULL OR p_byte_length NOT BETWEEN 1 AND 262144
    OR current_setting('server_encoding')<>'UTF8'
    OR octet_length(convert_to(p_original,'UTF8'))<>p_byte_length
    OR octet_length(convert_to(
      '{"kind":"inline","schemaVersion":1,"value":'||p_original||'}','UTF8'))>262144
    OR octet_length(p_value::text)>4194304
    OR encode(sha256(convert_to(p_original,'UTF8')),'hex')<>p_sha256 THEN
    RAISE EXCEPTION 'native inline execution value byte identity is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT (p_original IS JSON VALUE WITH UNIQUE KEYS) THEN
    RAISE EXCEPTION 'native inline execution value requires valid unique-key JSON' USING ERRCODE='22023';
  END IF;
  v_original_stack:=ARRAY[p_original::json];
  v_reference_stack:=ARRAY[p_value];
  v_depth_stack:=ARRAY[1];
  WHILE coalesce(array_length(v_original_stack,1),0)>0 LOOP
    v_index:=array_length(v_original_stack,1);
    v_original:=v_original_stack[v_index];
    v_reference:=v_reference_stack[v_index];
    v_depth:=v_depth_stack[v_index];
    v_original_stack:=v_original_stack[1:v_index-1];
    v_reference_stack:=v_reference_stack[1:v_index-1];
    v_depth_stack:=v_depth_stack[1:v_index-1];
    v_type:=json_typeof(v_original);
    IF v_type IS DISTINCT FROM jsonb_typeof(v_reference) THEN
      RAISE EXCEPTION 'native inline execution value reference type differs' USING ERRCODE='22023';
    END IF;
    IF v_type IN ('object','array') AND v_depth>64 THEN
      RAISE EXCEPTION 'native inline execution value exceeds depth bound' USING ERRCODE='22023';
    END IF;
    IF v_type='object' THEN
      SELECT count(*)::integer INTO v_children FROM json_each(v_original);
      IF v_children<>(SELECT count(*)::integer FROM jsonb_each(v_reference)) THEN
        RAISE EXCEPTION 'native inline execution value reference members differ' USING ERRCODE='22023';
      END IF;
      v_members:=v_members+v_children;
      IF v_members>10000 THEN
        RAISE EXCEPTION 'native inline execution value exceeds member bound' USING ERRCODE='22023';
      END IF;
      FOR v_child IN SELECT key,value FROM json_each(v_original) LOOP
        IF NOT (v_reference ? v_child.key) THEN
          RAISE EXCEPTION 'native inline execution value reference key differs' USING ERRCODE='22023';
        END IF;
        v_original_stack:=array_append(v_original_stack,v_child.value);
        v_reference_stack:=array_append(v_reference_stack,v_reference->v_child.key);
        v_depth_stack:=array_append(v_depth_stack,v_depth+1);
      END LOOP;
    ELSIF v_type='array' THEN
      v_children:=json_array_length(v_original);
      IF v_children<>jsonb_array_length(v_reference) THEN
        RAISE EXCEPTION 'native inline execution value reference array differs' USING ERRCODE='22023';
      END IF;
      v_members:=v_members+v_children;
      IF v_members>10000 THEN
        RAISE EXCEPTION 'native inline execution value exceeds member bound' USING ERRCODE='22023';
      END IF;
      FOR v_child IN SELECT value,ordinality FROM json_array_elements(v_original) WITH ORDINALITY LOOP
        v_original_stack:=array_append(v_original_stack,v_child.value);
        v_reference_stack:=array_append(v_reference_stack,v_reference->(v_child.ordinality::integer-1));
        v_depth_stack:=array_append(v_depth_stack,v_depth+1);
      END LOOP;
    ELSIF v_type='number' THEN
      IF app.native_execution_value_binary64_leaf(v_original::text)<>
         app.native_execution_value_binary64_leaf(v_reference::text) THEN
        RAISE EXCEPTION 'native inline execution value binary64 reference differs' USING ERRCODE='22023';
      END IF;
    ELSIF v_type IN ('string','boolean','null') THEN
      IF (v_original #>> '{}') IS DISTINCT FROM (v_reference #>> '{}') THEN
        RAISE EXCEPTION 'native inline execution value reference scalar differs' USING ERRCODE='22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'native inline execution value JSON type is unsupported' USING ERRCODE='22023';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.assert_native_inline_execution_value_bytes(jsonb,text,integer,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Supporting identities come from actual registered execution rows. A valid
-- workspace/attempt UUID pair alone does not prove the attempt belongs to the
-- claimed run/node/invocation. All referencing tuple fields are required below.
ALTER TABLE app.node_runs
  ADD CONSTRAINT node_runs_native_value_scope_unique
    UNIQUE (workspace_id, workflow_run_id, id, node_id, invocation_key);
ALTER TABLE app.node_attempts
  ADD CONSTRAINT node_attempts_native_value_scope_unique
    UNIQUE (workspace_id, node_run_id, id, attempt_number);

CREATE TABLE app.workflow_execution_value_provenance (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  value_slot varchar(32) NOT NULL,
  byte_ownership varchar(16) NOT NULL,
  node_run_id uuid,
  node_id varchar(128),
  invocation_key varchar(256),
  attempt_id uuid,
  attempt_number integer,
  accepted_revision bigint,
  coordinator_result_identity char(64),
  delivery_outbox_event_id uuid,
  delivery_payload_checksum char(64),
  reference_kind varchar(16),
  original_reference jsonb,
  original_inline_text text,
  artifact_id uuid,
  sha256 char(64),
  byte_length integer,
  media_type varchar(255),
  borrowed_from_provenance_id uuid,
  borrowed_from_slot varchar(32),
  borrowed_from_ownership varchar(16),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  eligible_until timestamptz NOT NULL,
  eligibility_revoked_at timestamptz,
  CONSTRAINT workflow_execution_value_workspace_identity_unique
    UNIQUE (workspace_id, id),
  CONSTRAINT workflow_execution_value_source_shape_unique
    UNIQUE (workspace_id, id, value_slot, byte_ownership),
  CONSTRAINT workflow_execution_value_artifact_identity_unique
    UNIQUE (workspace_id, id, workflow_run_id, workflow_version_id, value_slot,
            byte_ownership, reference_kind, artifact_id, sha256, byte_length, media_type),
  CONSTRAINT workflow_execution_value_attempt_identity_unique
    UNIQUE (workspace_id,id,node_run_id,node_id,invocation_key,attempt_id,attempt_number),
  CONSTRAINT workflow_execution_value_result_identity_unique
    UNIQUE (workspace_id,id,accepted_revision,coordinator_result_identity,
            delivery_outbox_event_id,delivery_payload_checksum),
  CONSTRAINT workflow_execution_value_run_version_fk
    FOREIGN KEY (workspace_id, workflow_run_id, workflow_version_id)
    REFERENCES app.workflow_runs (workspace_id, id, workflow_version_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_execution_value_node_scope_fk
    FOREIGN KEY (workspace_id, workflow_run_id, node_run_id, node_id, invocation_key)
    REFERENCES app.node_runs (workspace_id, workflow_run_id, id, node_id, invocation_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_execution_value_attempt_scope_fk
    FOREIGN KEY (workspace_id, node_run_id, attempt_id, attempt_number)
    REFERENCES app.node_attempts (workspace_id, node_run_id, id, attempt_number)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_execution_value_artifact_fk
    FOREIGN KEY (workspace_id, artifact_id)
    REFERENCES app.artifacts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_execution_value_borrowed_source_fk
    FOREIGN KEY (workspace_id, borrowed_from_provenance_id,
                 borrowed_from_slot, borrowed_from_ownership)
    REFERENCES app.workflow_execution_value_provenance
      (workspace_id, id, value_slot, byte_ownership)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_execution_value_slot_shape CHECK ((
    (
      value_slot='run_input'
      AND node_run_id IS NULL AND node_id IS NULL AND invocation_key IS NULL
      AND attempt_id IS NULL AND attempt_number IS NULL
      AND accepted_revision IS NULL AND coordinator_result_identity IS NULL
      AND delivery_outbox_event_id IS NULL AND delivery_payload_checksum IS NULL
    ) OR (
      value_slot IN ('attempt_input','attempt_output')
      AND node_run_id IS NOT NULL AND node_id IS NOT NULL
      AND invocation_key IS NOT NULL AND attempt_id IS NOT NULL
      AND attempt_number IS NOT NULL AND attempt_number>0
      AND accepted_revision IS NULL AND coordinator_result_identity IS NULL
      AND delivery_outbox_event_id IS NULL AND delivery_payload_checksum IS NULL
      AND byte_ownership='owned'
    ) OR (
      value_slot='run_result'
      AND node_run_id IS NULL AND node_id IS NULL AND invocation_key IS NULL
      AND attempt_id IS NULL AND attempt_number IS NULL
      AND accepted_revision IS NOT NULL AND accepted_revision>0
      AND coordinator_result_identity IS NOT NULL
      AND coordinator_result_identity ~ '^[0-9a-f]{64}$'
      AND delivery_outbox_event_id IS NOT NULL
      AND delivery_payload_checksum IS NOT NULL
      AND delivery_payload_checksum ~ '^[0-9a-f]{64}$'
      AND byte_ownership='owned'
    )
  ) IS TRUE),
  CONSTRAINT workflow_execution_value_byte_ownership_shape CHECK ((
    (
      byte_ownership='owned'
      AND borrowed_from_provenance_id IS NULL AND borrowed_from_slot IS NULL
      AND borrowed_from_ownership IS NULL
      AND reference_kind IN ('inline','artifact')
      AND original_reference IS NOT NULL
      AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$'
      AND byte_length IS NOT NULL AND byte_length BETWEEN 1 AND 1048576
      AND media_type='application/vnd.pertexo.execution-value+json;version=1'
      AND (value_slot<>'run_input' OR reference_kind='inline')
    ) OR (
      byte_ownership='borrowed' AND value_slot='run_input'
      AND borrowed_from_provenance_id IS NOT NULL
      AND borrowed_from_provenance_id<>id
      AND borrowed_from_slot='attempt_input' AND borrowed_from_ownership='owned'
      AND reference_kind IS NULL AND original_reference IS NULL
      AND original_inline_text IS NULL AND artifact_id IS NULL
      AND sha256 IS NULL AND byte_length IS NULL AND media_type IS NULL
    )
  ) IS TRUE),
  CONSTRAINT workflow_execution_value_owned_reference_shape CHECK ((
    byte_ownership='borrowed' OR (
      jsonb_typeof(original_reference)='object'
      AND octet_length(original_reference::text)<=4194304
      AND original_reference->'schemaVersion'='1'::jsonb
      AND original_reference->>'kind'=reference_kind
      AND (
        (
          reference_kind='inline' AND artifact_id IS NULL
          AND original_inline_text IS NOT NULL AND byte_length<=262144
          AND original_reference ? 'value'
          AND original_reference - ARRAY['kind','schemaVersion','value']='{}'::jsonb
          AND octet_length(convert_to(original_inline_text,'UTF8'))=byte_length
          AND octet_length(convert_to(
            '{"kind":"inline","schemaVersion":1,"value":'
              || original_inline_text || '}', 'UTF8'))<=262144
          AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(original_inline_text,'UTF8')),'hex')=sha256
        ) OR (
          reference_kind='artifact' AND artifact_id IS NOT NULL
          AND original_inline_text IS NULL
          AND original_reference->>'artifactId'=artifact_id::text
          AND NOT (original_reference ? 'value')
          AND original_reference - ARRAY['kind','schemaVersion','artifactId']='{}'::jsonb
        )
      )
    )
  ) IS TRUE),
  CONSTRAINT workflow_execution_value_finite_eligibility CHECK (
    isfinite(accepted_at) AND isfinite(eligible_until)
    AND eligible_until>accepted_at
    AND (eligibility_revoked_at IS NULL OR isfinite(eligibility_revoked_at))
  )
);

CREATE UNIQUE INDEX workflow_execution_value_run_input_unique
  ON app.workflow_execution_value_provenance (workspace_id,workflow_run_id)
  WHERE value_slot='run_input';
CREATE UNIQUE INDEX workflow_execution_value_attempt_input_unique
  ON app.workflow_execution_value_provenance (workspace_id,attempt_id)
  WHERE value_slot='attempt_input';
CREATE UNIQUE INDEX workflow_execution_value_attempt_output_unique
  ON app.workflow_execution_value_provenance (workspace_id,attempt_id)
  WHERE value_slot='attempt_output';
CREATE UNIQUE INDEX workflow_execution_value_run_result_unique
  ON app.workflow_execution_value_provenance (workspace_id,workflow_run_id)
  WHERE value_slot='run_result';
CREATE INDEX workflow_execution_value_run_scope_idx
  ON app.workflow_execution_value_provenance
    (workspace_id,workflow_run_id,workflow_version_id,id);
CREATE INDEX workflow_execution_value_node_scope_idx
  ON app.workflow_execution_value_provenance
    (workspace_id,workflow_run_id,node_run_id,node_id,invocation_key);
CREATE INDEX workflow_execution_value_attempt_scope_idx
  ON app.workflow_execution_value_provenance
    (workspace_id,node_run_id,attempt_id,attempt_number);
CREATE INDEX workflow_execution_value_artifact_idx
  ON app.workflow_execution_value_provenance (workspace_id,artifact_id,id)
  WHERE artifact_id IS NOT NULL;
CREATE INDEX workflow_execution_value_borrowed_source_idx
  ON app.workflow_execution_value_provenance
    (workspace_id,borrowed_from_provenance_id,eligible_until,id)
  WHERE byte_ownership='borrowed';

ALTER TABLE app.workflow_execution_value_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_execution_value_provenance FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.workflow_execution_value_provenance FROM PUBLIC,
  {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

-- Structural FK requires the producer to be exactly owned attempt_input, so
-- alias chains/cycles cannot satisfy it. Protected binding ingress and EVERY
-- resolution must additionally authenticate the immutable Call declaration,
-- admitted/sealed journal, exact parent/child/version/invocation and current
-- consumer/eligibility. No UUID-possession or table-scope policy substitutes.
-- Candidate remains guarded until the journal FK and those owners are complete.
-- Byte integrity checks above are backstops only: no jsonb reserialization,
-- numeric equality, or sampled vectors qualify unique-key/binary64 semantics.
-- Actual ingress must establish that independent contract before acceptance.
-- coordinator_result_identity is the accepted V1 selector/source/byte binding,
-- not the actual full plan fingerprint. The latter remains ONLY at its existing
-- checkpoint/receipt owner and is independently verified at final CAS/recovery.

-- Existing artifacts remain the metadata/lifecycle/capacity owner. This exact
-- metadata key is only a foreign-key target, not another reservation or counter.
ALTER TABLE app.artifacts
  ADD CONSTRAINT artifacts_native_value_identity_unique
    UNIQUE (workspace_id,id,purpose,sha256,byte_length,media_type);

CREATE TABLE app.workflow_execution_value_artifact_candidates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  artifact_purpose varchar(64) NOT NULL DEFAULT 'execution-value',
  workflow_run_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  value_slot varchar(32) NOT NULL,
  node_run_id uuid,
  node_id varchar(128),
  invocation_key varchar(256),
  attempt_id uuid,
  attempt_number integer,
  creation_fence_token bigint,
  creation_worker_id varchar(128),
  creation_outbox_event_id uuid NOT NULL,
  creation_payload_checksum char(64) NOT NULL,
  expected_revision bigint,
  result_revision bigint,
  coordinator_result_identity char(64),
  sha256 char(64) NOT NULL,
  byte_length integer NOT NULL,
  media_type varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  abandoned_at timestamptz,
  CONSTRAINT native_value_candidate_workspace_identity_unique
    UNIQUE (workspace_id,id),
  CONSTRAINT native_value_candidate_artifact_unique
    UNIQUE (workspace_id,artifact_id),
  CONSTRAINT native_value_candidate_association_identity_unique
    UNIQUE (workspace_id,id,workflow_run_id,workflow_version_id,value_slot,
            artifact_id,sha256,byte_length,media_type),
  CONSTRAINT native_value_candidate_attempt_identity_unique
    UNIQUE (workspace_id,id,node_run_id,node_id,invocation_key,attempt_id,attempt_number),
  CONSTRAINT native_value_candidate_result_identity_unique
    UNIQUE (workspace_id,id,expected_revision,result_revision,coordinator_result_identity,
            creation_outbox_event_id,creation_payload_checksum),
  CONSTRAINT native_value_candidate_run_version_fk
    FOREIGN KEY (workspace_id,workflow_run_id,workflow_version_id)
    REFERENCES app.workflow_runs (workspace_id,id,workflow_version_id)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_candidate_node_scope_fk
    FOREIGN KEY (workspace_id,workflow_run_id,node_run_id,node_id,invocation_key)
    REFERENCES app.node_runs (workspace_id,workflow_run_id,id,node_id,invocation_key)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_candidate_attempt_scope_fk
    FOREIGN KEY (workspace_id,node_run_id,attempt_id,attempt_number)
    REFERENCES app.node_attempts (workspace_id,node_run_id,id,attempt_number)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_candidate_artifact_identity_fk
    FOREIGN KEY (workspace_id,artifact_id,artifact_purpose,sha256,byte_length,media_type)
    REFERENCES app.artifacts (workspace_id,id,purpose,sha256,byte_length,media_type)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_candidate_identity_bounded CHECK ((
    artifact_purpose='execution-value'
    AND sha256 ~ '^[0-9a-f]{64}$' AND byte_length BETWEEN 1 AND 1048576
    AND media_type='application/vnd.pertexo.execution-value+json;version=1'
    AND creation_payload_checksum ~ '^[0-9a-f]{64}$'
    AND isfinite(created_at) AND (abandoned_at IS NULL OR isfinite(abandoned_at))
  ) IS TRUE),
  CONSTRAINT native_value_candidate_slot_shape CHECK ((
    (
      value_slot IN ('attempt_input','attempt_output')
      AND node_run_id IS NOT NULL AND node_id IS NOT NULL
      AND invocation_key IS NOT NULL AND attempt_id IS NOT NULL
      AND attempt_number IS NOT NULL AND attempt_number>0
      AND creation_fence_token IS NOT NULL AND creation_fence_token>=0
      AND creation_worker_id IS NOT NULL AND length(creation_worker_id)>0
      AND expected_revision IS NULL AND result_revision IS NULL
      AND coordinator_result_identity IS NULL
    ) OR (
      value_slot='run_result'
      AND node_run_id IS NULL AND node_id IS NULL AND invocation_key IS NULL
      AND attempt_id IS NULL AND attempt_number IS NULL
      AND creation_fence_token IS NULL AND creation_worker_id IS NULL
      AND expected_revision IS NOT NULL AND expected_revision>=0
      AND expected_revision<9007199254740991
      AND result_revision IS NOT NULL AND result_revision=expected_revision+1
      AND coordinator_result_identity IS NOT NULL
      AND coordinator_result_identity ~ '^[0-9a-f]{64}$'
    )
  ) IS TRUE)
);

CREATE UNIQUE INDEX native_value_candidate_attempt_slot_unique
  ON app.workflow_execution_value_artifact_candidates (workspace_id,attempt_id,value_slot)
  WHERE value_slot IN ('attempt_input','attempt_output');
CREATE UNIQUE INDEX native_value_candidate_result_slot_unique
  ON app.workflow_execution_value_artifact_candidates (workspace_id,workflow_run_id,expected_revision)
  WHERE value_slot='run_result';
CREATE INDEX native_value_candidate_run_scope_idx
  ON app.workflow_execution_value_artifact_candidates (workspace_id,workflow_run_id,workflow_version_id,id);
CREATE INDEX native_value_candidate_node_scope_idx
  ON app.workflow_execution_value_artifact_candidates (workspace_id,workflow_run_id,node_run_id,node_id,invocation_key);
CREATE INDEX native_value_candidate_attempt_scope_idx
  ON app.workflow_execution_value_artifact_candidates (workspace_id,node_run_id,attempt_id,attempt_number);

CREATE TABLE app.workflow_execution_value_artifact_associations (
  workspace_id uuid NOT NULL,
  provenance_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL,
  value_slot varchar(32) NOT NULL,
  node_run_id uuid,
  node_id varchar(128),
  invocation_key varchar(256),
  attempt_id uuid,
  attempt_number integer,
  expected_revision bigint,
  accepted_revision bigint,
  coordinator_result_identity char(64),
  delivery_outbox_event_id uuid,
  delivery_payload_checksum char(64),
  byte_ownership varchar(16) NOT NULL DEFAULT 'owned',
  reference_kind varchar(16) NOT NULL DEFAULT 'artifact',
  artifact_id uuid NOT NULL,
  sha256 char(64) NOT NULL,
  byte_length integer NOT NULL,
  media_type varchar(255) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,provenance_id),
  CONSTRAINT native_value_association_candidate_unique UNIQUE (workspace_id,candidate_id),
  CONSTRAINT native_value_association_shape CHECK ((
    byte_ownership='owned' AND reference_kind='artifact'
    AND value_slot IN ('attempt_input','attempt_output','run_result')
    AND sha256 ~ '^[0-9a-f]{64}$' AND byte_length BETWEEN 1 AND 1048576
    AND media_type='application/vnd.pertexo.execution-value+json;version=1'
    AND isfinite(accepted_at)
  ) IS TRUE),
  CONSTRAINT native_value_association_slot_scope CHECK ((
    (
      value_slot IN ('attempt_input','attempt_output')
      AND node_run_id IS NOT NULL AND node_id IS NOT NULL
      AND invocation_key IS NOT NULL AND attempt_id IS NOT NULL
      AND attempt_number IS NOT NULL AND attempt_number>0
      AND expected_revision IS NULL AND accepted_revision IS NULL
      AND coordinator_result_identity IS NULL
      AND delivery_outbox_event_id IS NULL AND delivery_payload_checksum IS NULL
    ) OR (
      value_slot='run_result'
      AND node_run_id IS NULL AND node_id IS NULL AND invocation_key IS NULL
      AND attempt_id IS NULL AND attempt_number IS NULL
      AND expected_revision IS NOT NULL AND expected_revision>=0
      AND expected_revision<9007199254740991
      AND accepted_revision IS NOT NULL AND accepted_revision=expected_revision+1
      AND coordinator_result_identity IS NOT NULL
      AND coordinator_result_identity ~ '^[0-9a-f]{64}$'
      AND delivery_outbox_event_id IS NOT NULL
      AND delivery_payload_checksum IS NOT NULL
      AND delivery_payload_checksum ~ '^[0-9a-f]{64}$'
    )
  ) IS TRUE),
  CONSTRAINT native_value_association_provenance_fk
    FOREIGN KEY (workspace_id,provenance_id,workflow_run_id,workflow_version_id,
                 value_slot,byte_ownership,reference_kind,artifact_id,sha256,byte_length,media_type)
    REFERENCES app.workflow_execution_value_provenance
      (workspace_id,id,workflow_run_id,workflow_version_id,value_slot,
       byte_ownership,reference_kind,artifact_id,sha256,byte_length,media_type)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_association_candidate_fk
    FOREIGN KEY (workspace_id,candidate_id,workflow_run_id,workflow_version_id,
                 value_slot,artifact_id,sha256,byte_length,media_type)
    REFERENCES app.workflow_execution_value_artifact_candidates
      (workspace_id,id,workflow_run_id,workflow_version_id,value_slot,
       artifact_id,sha256,byte_length,media_type)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_association_attempt_provenance_fk
    FOREIGN KEY (workspace_id,provenance_id,node_run_id,node_id,invocation_key,attempt_id,attempt_number)
    REFERENCES app.workflow_execution_value_provenance
      (workspace_id,id,node_run_id,node_id,invocation_key,attempt_id,attempt_number)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_association_attempt_candidate_fk
    FOREIGN KEY (workspace_id,candidate_id,node_run_id,node_id,invocation_key,attempt_id,attempt_number)
    REFERENCES app.workflow_execution_value_artifact_candidates
      (workspace_id,id,node_run_id,node_id,invocation_key,attempt_id,attempt_number)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_association_result_provenance_fk
    FOREIGN KEY (workspace_id,provenance_id,accepted_revision,coordinator_result_identity,
                 delivery_outbox_event_id,delivery_payload_checksum)
    REFERENCES app.workflow_execution_value_provenance
      (workspace_id,id,accepted_revision,coordinator_result_identity,
       delivery_outbox_event_id,delivery_payload_checksum)
    ON DELETE RESTRICT,
  CONSTRAINT native_value_association_result_candidate_fk
    FOREIGN KEY (workspace_id,candidate_id,expected_revision,accepted_revision,
                 coordinator_result_identity,delivery_outbox_event_id,delivery_payload_checksum)
    REFERENCES app.workflow_execution_value_artifact_candidates
      (workspace_id,id,expected_revision,result_revision,coordinator_result_identity,
       creation_outbox_event_id,creation_payload_checksum)
    ON DELETE RESTRICT
);
CREATE INDEX native_value_association_artifact_idx
  ON app.workflow_execution_value_artifact_associations (workspace_id,artifact_id,provenance_id);

ALTER TABLE app.workflow_execution_value_artifact_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_execution_value_artifact_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_execution_value_artifact_associations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_execution_value_artifact_associations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.workflow_execution_value_artifact_candidates,
  app.workflow_execution_value_artifact_associations FROM PUBLIC,
  {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

-- No candidate-side mutable accepted-parent pointer or independent status.
-- Protected owner projections derive candidate.provenance_id from the one
-- association row; insertion is the atomic acceptance association operation.
-- Exact attempt scope and coordinator result content/revision identity still
-- require the existing actual acceptance owner, not just matching these FKs.
-- A borrowed run_input cannot obtain its own association: it has no artifact ID
-- and the association slot/ownership check only admits owned producer slots.
-- Replacement deletes unaccepted candidate mapping only AFTER existing owner
-- confirms physical deletion; availability/deletion/capacity stay at artifacts.

-- Durable Call identity is not a second acceptance/idempotency/capacity owner.
-- Existing canonical acceptance creates the actual child and outbox under its
-- savepoint; this journal records its definite outcome and the post-CAS seal.
ALTER TABLE app.workflow_execution_value_provenance
  ADD CONSTRAINT native_value_call_declaration_scope_unique
    UNIQUE (workspace_id,id,workflow_run_id,workflow_version_id,node_run_id,
            node_id,invocation_key,attempt_id,attempt_number,value_slot,byte_ownership);

CREATE TABLE app.workflow_calls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  parent_workflow_version_id uuid NOT NULL,
  root_run_id uuid NOT NULL,
  node_run_id uuid,
  node_id varchar(128) NOT NULL,
  invocation_key varchar(256) NOT NULL,
  declaration_attempt_id uuid,
  declaration_attempt_number integer NOT NULL,
  declaration_input_provenance_id uuid,
  declaration_input_slot varchar(32) NOT NULL DEFAULT 'attempt_input',
  declaration_input_ownership varchar(16) NOT NULL DEFAULT 'owned',
  callee_workflow_id uuid NOT NULL,
  callee_workflow_version_id uuid NOT NULL,
  call_depth integer NOT NULL,
  inherited_deadline_at timestamptz NOT NULL,
  expected_parent_revision integer NOT NULL,
  parent_delivery_outbox_event_id uuid NOT NULL,
  parent_delivery_payload_checksum char(64) NOT NULL,
  outcome_kind varchar(16) NOT NULL,
  child_run_id uuid,
  child_workflow_version_id uuid,
  child_outbox_event_id uuid,
  child_outbox_payload_checksum char(64),
  refusal_code varchar(128),
  abort_reason varchar(32),
  sealed boolean NOT NULL DEFAULT false,
  sealed_parent_revision integer,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail_retired_at timestamptz,
  CONSTRAINT workflow_calls_workspace_identity_unique UNIQUE (workspace_id,id),
  CONSTRAINT workflow_calls_parent_invocation_unique UNIQUE (workspace_id,parent_run_id,invocation_key),
  CONSTRAINT workflow_calls_borrowed_child_identity_unique
    UNIQUE (workspace_id,id,child_run_id,child_workflow_version_id,
            declaration_input_provenance_id,outcome_kind,sealed),
  CONSTRAINT workflow_calls_parent_version_fk
    FOREIGN KEY (workspace_id,parent_run_id,parent_workflow_version_id)
    REFERENCES app.workflow_runs (workspace_id,id,workflow_version_id) ON DELETE RESTRICT,
  CONSTRAINT workflow_calls_root_fk
    FOREIGN KEY (workspace_id,root_run_id)
    REFERENCES app.workflow_runs (workspace_id,id) ON DELETE RESTRICT,
  CONSTRAINT workflow_calls_declaration_scope_fk
    FOREIGN KEY (workspace_id,declaration_input_provenance_id,parent_run_id,
                 parent_workflow_version_id,node_run_id,node_id,invocation_key,
                 declaration_attempt_id,declaration_attempt_number,
                 declaration_input_slot,declaration_input_ownership)
    REFERENCES app.workflow_execution_value_provenance
      (workspace_id,id,workflow_run_id,workflow_version_id,node_run_id,node_id,
       invocation_key,attempt_id,attempt_number,value_slot,byte_ownership)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_calls_callee_version_fk
    FOREIGN KEY (workspace_id,callee_workflow_id,callee_workflow_version_id)
    REFERENCES app.workflow_versions (workspace_id,workflow_id,id) ON DELETE RESTRICT,
  CONSTRAINT workflow_calls_child_version_fk
    FOREIGN KEY (workspace_id,child_run_id,child_workflow_version_id)
    REFERENCES app.workflow_runs (workspace_id,id,workflow_version_id) ON DELETE RESTRICT,
  CONSTRAINT workflow_calls_declaration_shape CHECK ((
    declaration_input_slot='attempt_input' AND declaration_input_ownership='owned'
    AND declaration_attempt_number>0 AND call_depth BETWEEN 1 AND 4
    AND (child_run_id IS NULL OR
      (root_run_id<>child_run_id AND parent_run_id<>child_run_id))
    AND expected_parent_revision BETWEEN 0 AND 2147483646
    AND parent_delivery_payload_checksum ~ '^[0-9a-f]{64}$'
    AND isfinite(inherited_deadline_at) AND isfinite(recorded_at)
  ) IS TRUE),
  CONSTRAINT workflow_calls_detail_retirement_shape CHECK ((
    (detail_retired_at IS NULL AND node_run_id IS NOT NULL
      AND declaration_attempt_id IS NOT NULL AND declaration_input_provenance_id IS NOT NULL)
    OR (detail_retired_at IS NOT NULL AND isfinite(detail_retired_at) AND sealed
      AND node_run_id IS NULL AND declaration_attempt_id IS NULL
      AND declaration_input_provenance_id IS NULL)
  ) IS TRUE),
  CONSTRAINT workflow_calls_outcome_shape CHECK ((
    (
      outcome_kind='admitted' AND child_run_id IS NOT NULL
      AND child_workflow_version_id=callee_workflow_version_id
      AND child_outbox_event_id IS NOT NULL AND child_outbox_payload_checksum IS NOT NULL
      AND child_outbox_payload_checksum ~ '^[0-9a-f]{64}$'
      AND refusal_code IS NULL AND abort_reason IS NULL
    ) OR (
      outcome_kind='refused' AND child_run_id IS NULL AND child_workflow_version_id IS NULL
      AND child_outbox_event_id IS NULL AND child_outbox_payload_checksum IS NULL
      AND refusal_code IN (
        'workflow.child_capacity_unavailable','workflow.child_queue_unavailable',
        'workflow.child_entitlement_unavailable','workflow.child_authority_unavailable',
        'workflow.child_admission_unavailable','workflow.child_compatibility_unavailable'
      ) AND abort_reason IS NULL
    ) OR (
      outcome_kind='aborted' AND child_run_id IS NULL AND child_workflow_version_id IS NULL
      AND child_outbox_event_id IS NULL AND child_outbox_payload_checksum IS NULL
      AND refusal_code IS NULL AND abort_reason IN ('cancel_requested','deadline_expired')
    )
  ) IS TRUE),
  CONSTRAINT workflow_calls_seal_shape CHECK ((
    (NOT sealed AND sealed_parent_revision IS NULL)
    OR (sealed AND sealed_parent_revision=expected_parent_revision+1)
  ) IS TRUE)
);
CREATE UNIQUE INDEX workflow_calls_child_unique
  ON app.workflow_calls (workspace_id,child_run_id) WHERE outcome_kind='admitted';
CREATE INDEX workflow_calls_root_idx ON app.workflow_calls (workspace_id,root_run_id,id);
CREATE INDEX workflow_calls_callee_idx
  ON app.workflow_calls (workspace_id,callee_workflow_id,callee_workflow_version_id,id);
CREATE INDEX workflow_calls_declaration_idx
  ON app.workflow_calls (workspace_id,declaration_input_provenance_id,id);

ALTER TABLE app.workflow_execution_value_provenance
  ADD COLUMN borrowed_workflow_call_id uuid,
  ADD COLUMN borrowed_call_outcome varchar(16),
  ADD COLUMN borrowed_call_sealed boolean,
  ADD CONSTRAINT native_value_borrowed_journal_shape CHECK ((
    (
      byte_ownership='owned' AND borrowed_workflow_call_id IS NULL
      AND borrowed_call_outcome IS NULL AND borrowed_call_sealed IS NULL
    ) OR (
      byte_ownership='borrowed' AND borrowed_workflow_call_id IS NOT NULL
      AND borrowed_call_outcome='admitted' AND borrowed_call_sealed
    )
  ) IS TRUE),
  ADD CONSTRAINT native_value_borrowed_journal_fk
    FOREIGN KEY (workspace_id,borrowed_workflow_call_id,workflow_run_id,
                 workflow_version_id,borrowed_from_provenance_id,
                 borrowed_call_outcome,borrowed_call_sealed)
    REFERENCES app.workflow_calls
      (workspace_id,id,child_run_id,child_workflow_version_id,
       declaration_input_provenance_id,outcome_kind,sealed)
    ON DELETE RESTRICT;
CREATE INDEX native_value_borrowed_journal_idx
  ON app.workflow_execution_value_provenance (workspace_id,borrowed_workflow_call_id,id)
  WHERE byte_ownership='borrowed';

ALTER TABLE app.workflow_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_calls FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.workflow_calls FROM PUBLIC,
  {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

-- Private execution/source tripwire. Historical lineage stays available to its
-- future authorized summary reader, but can NEVER authorize live detail use.
CREATE FUNCTION app.assert_native_call_detail_live(p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  IF v_workspace IS NULL OR p_run IS NULL THEN
    RAISE EXCEPTION 'native Call detail scope is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workflow_calls retired
    WHERE retired.workspace_id=v_workspace AND retired.detail_retired_at IS NOT NULL
      AND retired.root_run_id IN (SELECT related.root_run_id FROM app.workflow_calls related
        WHERE related.workspace_id=v_workspace AND
          (related.parent_run_id=p_run OR related.child_run_id=p_run OR related.root_run_id=p_run))) THEN
    RAISE EXCEPTION 'native Call execution detail is retired' USING ERRCODE='55000';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_native_call_detail_live(uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE INDEX workflow_calls_retired_root_idx ON app.workflow_calls(workspace_id,root_run_id,id)
  WHERE detail_retired_at IS NOT NULL;

-- Borrowed input insertion belongs to the existing final seal transaction after
-- actual parent CAS, child canonical acceptance/admission and journal seal. This
-- FK cannot point to an unsealed/refused/aborted journal or another child's input.
-- No caller-selected declaration UUID, lineage label, seal flag or result label
-- is authority. Protected owner functions must independently derive them.
-- Historical outbox IDs/checksums are immutable journal identity, not permanent
-- FKs that pin transient queue rows. Actual acceptance independently verifies
-- canonical outbox payload/receipt on the same transaction before sealing.
-- REQUIRED BEFORE INSTALLATION: authenticated outcome ingress/post-CAS seal and
-- deferred final seal obligations, actual family counters/lineage/current control
-- proof, protected borrow resolution and existing retention/purge extensions.

-- Extend the EXISTING bounded artifact retention owner. Discovery never takes
-- execution locks; destructive steps still require its existing advisory gate,
-- workspace control UPDATE and physical delete/head confirmation outside SQL.
-- Accepted provenance and unresolved candidates remain referenced. Protected
-- detail teardown may remove a completed producer's expired mapping; absence
-- then does not permanently pin expired object bytes/capacity. Physical cleanup
-- still belongs exclusively to this existing owner, after all references clear.
CREATE OR REPLACE FUNCTION app.find_due_run_artifact_retention(p_limit integer)
RETURNS TABLE(workspace_id uuid,artifact_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid run artifact retention discovery limit'
      USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT artifact.workspace_id,artifact.id
  FROM app.artifacts artifact
  WHERE (
      (artifact.status='pending' AND artifact.purpose IN ('user-upload','execution-value')
        AND artifact.expires_at<=clock_timestamp())
      OR (artifact.status='available' AND artifact.expires_at<=clock_timestamp())
      OR artifact.status='deleting'
    )
    AND (artifact.retention_retry_at IS NULL
      OR artifact.retention_retry_at<=clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=artifact.workspace_id
        AND link.artifact_id=artifact.id)
  ORDER BY artifact.expires_at,artifact.id LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION app.prepare_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS varchar LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_artifact app.artifacts%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_artifact_id IS NULL
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL
    OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid run artifact retention step' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  -- Native commands take workspace SHARE first. Destructive workspace UPDATE
  -- therefore excludes new candidates/acceptance before this ordered inventory.
  PERFORM candidate.id FROM app.workflow_execution_value_artifact_candidates candidate
    WHERE candidate.workspace_id=p_workspace_id AND candidate.artifact_id=p_artifact_id
    ORDER BY candidate.id FOR UPDATE;
  PERFORM provenance.id FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=p_workspace_id AND provenance.artifact_id=p_artifact_id
    ORDER BY provenance.id FOR UPDATE;
  SELECT * INTO v_artifact FROM app.artifacts artifact
    WHERE artifact.workspace_id=p_workspace_id AND artifact.id=p_artifact_id
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_artifact.status='pending' THEN
    IF v_artifact.purpose NOT IN ('user-upload','execution-value')
      OR v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  ELSIF v_artifact.status='available' THEN
    IF v_artifact.expires_at>clock_timestamp() THEN RETURN 'stale'; END IF;
  ELSIF v_artifact.status<>'deleting' THEN
    RETURN 'stale';
  ELSIF v_artifact.retention_retry_at IS NOT NULL
    AND v_artifact.retention_retry_at>clock_timestamp() THEN
    RETURN 'stale';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 day',
      updated_at=clock_timestamp() WHERE workspace_id=p_workspace_id AND id=p_artifact_id;
    RETURN 'held';
  END IF;
  -- A present unresolved candidate or ANY accepted parent protects bytes.
  -- Old creator lease/uncertain COMMIT is insufficient. A mapping removed by
  -- actual completed-producer detail retention cannot become a permanent pin.
  -- A definitively abandoned candidate does not self-pin through its producer,
  -- nonterminal family or replay state. Independent accepted references below
  -- still protect it, as does the legal hold checked above.
  IF (v_artifact.purpose='execution-value' AND EXISTS (
      SELECT 1 FROM app.workflow_execution_value_artifact_candidates candidate
      WHERE candidate.workspace_id=p_workspace_id AND candidate.artifact_id=p_artifact_id
        AND candidate.abandoned_at IS NULL
    ))
    OR EXISTS (SELECT 1 FROM app.workflow_execution_value_provenance provenance
      WHERE provenance.workspace_id=p_workspace_id AND provenance.artifact_id=p_artifact_id)
    OR EXISTS (SELECT 1 FROM app.workflow_execution_value_artifact_associations association
      WHERE association.workspace_id=p_workspace_id AND association.artifact_id=p_artifact_id)
    OR EXISTS (SELECT 1 FROM app.artifact_links link
      WHERE link.workspace_id=p_workspace_id AND link.artifact_id=p_artifact_id)
    OR EXISTS (SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=p_workspace_id
      AND (app.jsonb_references_artifact(run.input_ref,p_artifact_id)
        OR app.jsonb_references_artifact(run.output_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.node_runs node WHERE node.workspace_id=p_workspace_id
      AND (app.jsonb_references_artifact(node.input_ref,p_artifact_id)
        OR app.jsonb_references_artifact(node.output_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.node_attempts attempt
      WHERE attempt.workspace_id=p_workspace_id
        AND (app.jsonb_references_artifact(attempt.output_ref,p_artifact_id)
          OR app.jsonb_references_artifact(attempt.reconciliation_ref,p_artifact_id)))
    OR EXISTS (SELECT 1 FROM app.run_events event WHERE event.workspace_id=p_workspace_id
      AND app.jsonb_references_artifact(event.payload,p_artifact_id))
    OR EXISTS (SELECT 1 FROM app.run_checkpoints checkpoint
      WHERE checkpoint.workspace_id=p_workspace_id
        AND app.jsonb_references_artifact(checkpoint.scheduler_state,p_artifact_id)) THEN
    UPDATE app.artifacts SET retention_retry_at=clock_timestamp()+interval '1 day',
      updated_at=clock_timestamp() WHERE workspace_id=p_workspace_id AND id=p_artifact_id;
    RETURN 'referenced';
  END IF;
  UPDATE app.artifacts SET status='deleting',
    retention_retry_at=clock_timestamp()+interval '1 minute',
    updated_at=clock_timestamp() WHERE workspace_id=p_workspace_id AND id=p_artifact_id;
  RETURN 'artifact';
END $$;

CREATE OR REPLACE FUNCTION app.complete_run_artifact_retention(
  p_workspace_id uuid,p_artifact_id uuid,p_expected_control_sequence bigint,
  p_expected_control_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_artifact app.artifacts%ROWTYPE;
BEGIN
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=p_workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=p_workspace_id AND hold.released_at IS NULL) THEN
    RETURN false;
  END IF;
  PERFORM candidate.id FROM app.workflow_execution_value_artifact_candidates candidate
    WHERE candidate.workspace_id=p_workspace_id AND candidate.artifact_id=p_artifact_id
    ORDER BY candidate.id FOR UPDATE;
  PERFORM provenance.id FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=p_workspace_id AND provenance.artifact_id=p_artifact_id
    ORDER BY provenance.id FOR UPDATE;
  SELECT * INTO v_artifact FROM app.artifacts artifact
    WHERE artifact.workspace_id=p_workspace_id AND artifact.id=p_artifact_id
    FOR UPDATE;
  IF NOT FOUND OR v_artifact.status<>'deleting' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM app.workflow_execution_value_provenance provenance
      WHERE provenance.workspace_id=p_workspace_id AND provenance.artifact_id=p_artifact_id)
    OR EXISTS (SELECT 1 FROM app.workflow_execution_value_artifact_associations association
      WHERE association.workspace_id=p_workspace_id AND association.artifact_id=p_artifact_id)
    OR (v_artifact.purpose='execution-value' AND EXISTS (
      SELECT 1 FROM app.workflow_execution_value_artifact_candidates candidate
      WHERE candidate.workspace_id=p_workspace_id AND candidate.artifact_id=p_artifact_id
        AND candidate.abandoned_at IS NULL
    )) THEN
    RETURN false;
  END IF;
  -- Existing coordinator calls this only AFTER both regions confirm removal.
  -- Deleting metadata here is transactional with the actual artifact deletion:
  -- its existing trigger alone releases capacity; failure rolls everything back.
  DELETE FROM app.workflow_execution_value_artifact_candidates candidate
    WHERE candidate.workspace_id=p_workspace_id AND candidate.artifact_id=p_artifact_id
      AND candidate.abandoned_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM app.workflow_execution_value_artifact_associations association
        WHERE association.workspace_id=candidate.workspace_id AND association.candidate_id=candidate.id);
  DELETE FROM app.artifacts artifact WHERE artifact.workspace_id=p_workspace_id
    AND artifact.id=p_artifact_id AND artifact.status='deleting';
  RETURN FOUND;
END $$;

-- Existing maintenance signatures/grants and defer owner are retained; no new
-- reaper, storage owner, destructive authority or caller confirmation is added.
-- Protected detail metadata retirement below does not release capacity here.

-- Mutation tripwires are not authority. The future protected ingress/seal owner
-- must derive actual producer/declaration/transition truth before these writes.
-- No role/grant/policy is added here, and no trigger acquires execution locks in
-- an inverse order: the owner must already hold the prescribed workspace and
-- ordered producer/candidate/provenance/artifact locks.
CREATE FUNCTION app.guard_native_execution_value_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF TG_TABLE_NAME='workflow_execution_value_provenance' THEN
    IF (to_jsonb(NEW)-'eligibility_revoked_at') IS DISTINCT FROM
       (to_jsonb(OLD)-'eligibility_revoked_at')
      OR NEW.original_reference::text IS DISTINCT FROM OLD.original_reference::text
      OR (OLD.eligibility_revoked_at IS NOT NULL
        AND NEW.eligibility_revoked_at IS DISTINCT FROM OLD.eligibility_revoked_at) THEN
      RAISE EXCEPTION 'accepted native execution value is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='workflow_execution_value_artifact_candidates' THEN
    IF (to_jsonb(NEW)-'abandoned_at') IS DISTINCT FROM (to_jsonb(OLD)-'abandoned_at')
      OR (OLD.abandoned_at IS NOT NULL AND NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at) THEN
      RAISE EXCEPTION 'native execution value candidate identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.abandoned_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM app.workflow_execution_value_artifact_associations association
      WHERE association.workspace_id=NEW.workspace_id AND association.candidate_id=NEW.id
    ) THEN
      RAISE EXCEPTION 'accepted native execution value candidate cannot be abandoned' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='workflow_execution_value_artifact_associations' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'accepted native execution value association is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='workflow_calls' THEN
    -- A structural tripwire, NOT a retention lease/control authorization.
    -- Runtime table writes are revoked; only the private existing-retention
    -- extension may prove the actual lease/high water/family before detaching.
    IF OLD.detail_retired_at IS NOT NULL THEN
      IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'retired native Call identity is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.detail_retired_at IS NOT NULL THEN
      IF NOT OLD.sealed OR NOT NEW.sealed
        OR (to_jsonb(NEW)-ARRAY['detail_retired_at','node_run_id','declaration_attempt_id','declaration_input_provenance_id'])
          IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['detail_retired_at','node_run_id','declaration_attempt_id','declaration_input_provenance_id'])
        OR NEW.node_run_id IS NOT NULL OR NEW.declaration_attempt_id IS NOT NULL
        OR NEW.declaration_input_provenance_id IS NOT NULL
        OR NOT isfinite(NEW.detail_retired_at)
        OR EXISTS (SELECT 1 FROM app.workflow_execution_value_provenance borrowed
          WHERE borrowed.workspace_id=OLD.workspace_id AND borrowed.borrowed_workflow_call_id=OLD.id) THEN
        RAISE EXCEPTION 'native Call detail retirement shape differs' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW)-ARRAY['sealed','sealed_parent_revision']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['sealed','sealed_parent_revision'])
      OR (OLD.sealed AND
        (NOT NEW.sealed OR NEW.sealed_parent_revision IS DISTINCT FROM OLD.sealed_parent_revision)) THEN
      RAISE EXCEPTION 'native Call outcome identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid native execution value mutation target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_native_execution_value_mutation()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE TRIGGER native_value_provenance_immutable BEFORE UPDATE
  ON app.workflow_execution_value_provenance FOR EACH ROW
  EXECUTE FUNCTION app.guard_native_execution_value_mutation();
CREATE TRIGGER native_value_candidate_immutable BEFORE UPDATE
  ON app.workflow_execution_value_artifact_candidates FOR EACH ROW
  EXECUTE FUNCTION app.guard_native_execution_value_mutation();
CREATE TRIGGER native_value_association_immutable BEFORE UPDATE
  ON app.workflow_execution_value_artifact_associations FOR EACH ROW
  EXECUTE FUNCTION app.guard_native_execution_value_mutation();
CREATE TRIGGER native_call_outcome_immutable BEFORE UPDATE
  ON app.workflow_calls FOR EACH ROW
  EXECUTE FUNCTION app.guard_native_execution_value_mutation();

CREATE FUNCTION app.check_native_execution_value_commit_obligations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_call app.workflow_calls%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='workflow_calls' THEN
    -- Inspect FINAL durable row, not the queued INSERT's unsealed NEW image.
    -- This permits canonical child acceptance -> parent CAS -> journal seal ->
    -- borrowed child binding in the same existing coordinator transaction.
    SELECT * INTO v_call FROM app.workflow_calls call
      WHERE call.workspace_id=NEW.workspace_id AND call.id=NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF NOT v_call.sealed THEN
      RAISE EXCEPTION 'native Call outcome must seal before commit' USING ERRCODE='23514';
    END IF;
    -- Retirement's closed shape and private retention owner replace the live
    -- borrow obligation; cleared pointers never imply a new live admission.
    IF v_call.detail_retired_at IS NOT NULL THEN RETURN NULL; END IF;
    IF v_call.outcome_kind='admitted' AND NOT EXISTS (
      SELECT 1 FROM app.workflow_execution_value_provenance binding
      WHERE binding.workspace_id=v_call.workspace_id
        AND binding.workflow_run_id=v_call.child_run_id
        AND binding.workflow_version_id=v_call.child_workflow_version_id
        AND binding.value_slot='run_input' AND binding.byte_ownership='borrowed'
        AND binding.borrowed_workflow_call_id=v_call.id
        AND binding.borrowed_from_provenance_id=v_call.declaration_input_provenance_id
        AND binding.borrowed_call_outcome='admitted' AND binding.borrowed_call_sealed
    ) THEN
      RAISE EXCEPTION 'admitted native child input binding is missing' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='workflow_execution_value_artifact_associations' THEN
    IF EXISTS (
      SELECT 1 FROM app.workflow_execution_value_artifact_associations association
      JOIN app.workflow_execution_value_artifact_candidates candidate
        ON candidate.workspace_id=association.workspace_id AND candidate.id=association.candidate_id
      JOIN app.artifacts artifact
        ON artifact.workspace_id=association.workspace_id AND artifact.id=association.artifact_id
      WHERE association.workspace_id=NEW.workspace_id AND association.provenance_id=NEW.provenance_id
        AND (candidate.abandoned_at IS NOT NULL OR artifact.status<>'available'
          OR artifact.deleted_at IS NOT NULL OR artifact.expires_at<=clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'accepted native value candidate is abandoned or unavailable' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid native execution value commit target' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_native_execution_value_commit_obligations()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE CONSTRAINT TRIGGER native_call_final_seal_required AFTER INSERT OR UPDATE
  ON app.workflow_calls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_native_execution_value_commit_obligations();
CREATE CONSTRAINT TRIGGER native_value_candidate_acceptance_required AFTER INSERT OR UPDATE
  ON app.workflow_execution_value_artifact_associations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_native_execution_value_commit_obligations();

-- These are structural final-state obligations ONLY. A completed inbox receipt,
-- revision, journal seal flag or candidate content binding is never sufficient
-- proof of canonical delivery/full transition fingerprint/checkpoint/result.
-- Actual final CAS and recovery must independently use their EXISTING owner;
-- no full-plan fingerprint is copied into the new journal or value tables.

-- Root inline-or-omitted ingress is part of EXISTING canonical acceptance,
-- AFTER that transaction's actual run/checkpoint/outbox/idempotency completion.
-- No root artifact ingress, independent acceptance, quota or receipt is added.
CREATE FUNCTION app.record_native_root_execution_input(
  p_run_id uuid,p_acceptance_id uuid,p_original text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_claim app.idempotency_records%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_event app.outbox_events%ROWTYPE;
  v_existing app.workflow_execution_value_provenance%ROWTYPE;
  v_payload_text text;
  v_sha256 text;
  v_length integer;
BEGIN
  IF v_workspace IS NULL OR p_run_id IS NULL OR p_acceptance_id IS NULL THEN
    RAISE EXCEPTION 'native root input context is invalid' USING ERRCODE='22023';
  END IF;
  IF app.lock_workspace_run_admission(v_workspace) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'native root input workspace is unavailable' USING ERRCODE='55000';
  END IF;
  -- These rows are already held by the canonical acceptance transaction.
  SELECT * INTO v_claim FROM app.idempotency_records claim
    WHERE claim.workspace_id=v_workspace AND claim.id=p_acceptance_id FOR UPDATE;
  IF NOT FOUND OR (v_claim.operation='workflow.run.accept' AND v_claim.status='completed'
    AND v_claim.resource_id=p_run_id
    AND v_claim.result_ref->>'initialCheckpointHash' ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native root input canonical claim is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs run
    WHERE run.workspace_id=v_workspace AND run.id=p_run_id FOR UPDATE;
  IF NOT FOUND OR (v_run.status='queued' AND v_run.cancel_requested_at IS NULL
    AND v_run.trigger_type='manual' AND v_run.native_initiating_actor_id IS NOT NULL
    AND v_run.native_initiating_role_revision>0) IS NOT TRUE THEN
    RAISE EXCEPTION 'native root input canonical root is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_version FROM app.workflow_versions version
    WHERE version.workspace_id=v_workspace AND version.workflow_id=v_run.workflow_id
      AND version.id=v_run.workflow_version_id;
  IF NOT FOUND OR (v_version.schema_version=2 AND v_version.executable_schema_version=3
    AND v_version.checksum ~ '^wf:v3:sha256:[0-9a-f]{64}$'
    AND v_version.executable_json#>'{familyPolicy,defaultMaxRunDurationMs}'='3600000'::jsonb
    AND v_run.deadline_at IS NOT NULL AND isfinite(v_run.deadline_at)
    AND v_run.deadline_at<=v_run.created_at+coalesce(
      (v_version.executable_json#>>'{graph,settings,maxRunDurationMs}')::integer,
      (v_version.executable_json#>>'{familyPolicy,defaultMaxRunDurationMs}')::integer
    )*interval '1 millisecond'
    AND v_version.executable_json IS NOT NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'native root input immutable executable is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint
    WHERE checkpoint.workspace_id=v_workspace AND checkpoint.workflow_run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR (v_checkpoint.workflow_version_id=v_run.workflow_version_id
    AND v_checkpoint.revision=0
    AND v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND v_checkpoint.scheduler_state->>'workflowVersionId'=v_run.workflow_version_id::text
    AND v_checkpoint.scheduler_state->>'engineVersion'=v_checkpoint.engine_version
    AND v_checkpoint.scheduler_state->'revision'='0'::jsonb
    AND v_checkpoint.scheduler_state->>'runStatus'='queued'
    AND v_checkpoint.scheduler_state->'nextEventSequence'='2'::jsonb
    AND v_checkpoint.scheduler_state->'readySet'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'admittedInvocationKeys'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'invocations'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'joins'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'loops'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'branchSelections'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'calls'='[]'::jsonb
    AND v_checkpoint.scheduler_state->'cancelRequested'='false'::jsonb
    AND v_checkpoint.scheduler_state->'deadlineExpired'='false'::jsonb
    AND (v_checkpoint.scheduler_state->>'remainingIterationBudget')::integer BETWEEN 0 AND 10000
    AND v_checkpoint.scheduler_state-ARRAY['schemaVersion','engineVersion','workflowVersionId',
      'revision','runStatus','nextEventSequence','readySet','admittedInvocationKeys','invocations',
      'joins','loops','branchSelections','calls','remainingIterationBudget','cancelRequested',
      'deadlineExpired']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native root input initial checkpoint differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_event FROM app.outbox_events event
    WHERE event.workspace_id=v_workspace AND event.id=(v_claim.result_ref->>'outboxEventId')::uuid;
  IF NOT FOUND OR (v_event.job_name='advance-workflow-run' AND v_event.schema_version=1
    AND v_event.aggregate_type='workflow-run' AND v_event.aggregate_id=p_run_id
    AND v_event.payload->'schemaVersion'='1'::jsonb
    AND v_event.payload->>'workspaceId'=v_workspace::text
    AND v_event.payload->>'runId'=p_run_id::text
    AND v_event.payload->>'outboxEventId'=v_event.id::text
    AND v_event.payload-ARRAY['schemaVersion','workspaceId','runId','outboxEventId','traceparent']='{}'::jsonb
    AND v_event.payload_checksum ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native root input initial delivery differs' USING ERRCODE='55000';
  END IF;
  -- Fixed existing advance-job UUID/trace grammar, not a generic JSON encoder.
  v_payload_text:='{"outboxEventId":"'||v_event.id::text||'","runId":"'||p_run_id::text||'","schemaVersion":1';
  IF v_event.payload ? 'traceparent' THEN
    IF (v_event.payload->>'traceparent' ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
      AND substring(v_event.payload->>'traceparent',4,32)<>repeat('0',32)
      AND substring(v_event.payload->>'traceparent',37,16)<>repeat('0',16)) IS NOT TRUE THEN
      RAISE EXCEPTION 'native root input initial trace is invalid' USING ERRCODE='22023';
    END IF;
    v_payload_text:=v_payload_text||',"traceparent":"'||(v_event.payload->>'traceparent')||'"';
  END IF;
  v_payload_text:=v_payload_text||',"workspaceId":"'||v_workspace::text||'"}';
  IF encode(sha256(convert_to(v_payload_text,'UTF8')),'hex')<>v_event.payload_checksum THEN
    RAISE EXCEPTION 'native root input canonical delivery checksum differs' USING ERRCODE='55000';
  END IF;
  IF p_original IS NULL THEN
    IF v_run.input_ref IS NOT NULL OR v_run.input_ref_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'native root input absence differs' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF (v_run.input_ref->'schemaVersion'='1'::jsonb AND v_run.input_ref->>'kind'='inline'
    AND v_run.input_ref ? 'value' AND v_run.input_ref-ARRAY['kind','schemaVersion','value']='{}'::jsonb
    AND v_run.input_ref_expires_at>clock_timestamp() AND isfinite(v_run.input_ref_expires_at)) IS NOT TRUE THEN
    RAISE EXCEPTION 'native root input must be an eligible inline value' USING ERRCODE='23514';
  END IF;
  v_sha256:=encode(sha256(convert_to(p_original,'UTF8')),'hex');
  v_length:=octet_length(convert_to(p_original,'UTF8'));
  PERFORM app.assert_native_inline_execution_value_bytes(v_run.input_ref->'value',v_sha256,v_length,p_original);
  SELECT * INTO v_existing FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.workflow_run_id=p_run_id
      AND provenance.value_slot='run_input' FOR UPDATE;
  IF FOUND THEN
    IF (v_existing.byte_ownership='owned' AND v_existing.workflow_version_id=v_run.workflow_version_id
      AND v_existing.original_inline_text=p_original AND v_existing.sha256=v_sha256
      AND v_existing.byte_length=v_length AND v_existing.eligibility_revoked_at IS NULL
      AND v_existing.eligible_until=v_run.input_ref_expires_at
      AND v_existing.original_reference::text=v_run.input_ref::text) IS NOT TRUE THEN
      RAISE EXCEPTION 'native root input immutable identity differs' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  INSERT INTO app.workflow_execution_value_provenance (
    id,workspace_id,workflow_run_id,workflow_version_id,value_slot,byte_ownership,
    reference_kind,original_reference,original_inline_text,sha256,byte_length,media_type,
    accepted_at,eligible_until
  ) VALUES (gen_random_uuid(),v_workspace,p_run_id,v_run.workflow_version_id,'run_input','owned',
    'inline',v_run.input_ref,p_original,v_sha256,v_length,
    'application/vnd.pertexo.execution-value+json;version=1',v_run.created_at,v_run.input_ref_expires_at);
END $$;
REVOKE ALL ON FUNCTION app.record_native_root_execution_input(uuid,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- These checks enforce durable shape/scope/bytes under the actual acceptance
-- owner, NOT adversarial proof that runtime-written initial rows were created
-- by that owner. Publication/command authority and protected initial-checkpoint
-- validation remain exact qualification gates; no attestation/GUC trust flag or
-- duplicated full transition fingerprint is introduced here.

-- Private current-owner proof for the EXISTING Call input record/read methods.
-- All context is derived from durable run/node/attempt/transport/journal rows;
-- no caller workspace, root, graph pin, expiry or ancestry claim is accepted.
-- Publication semantics/adversarial native-table authority remain separate open
-- gates. This source does NOT equate an executable version label with semantic
-- publication validation; installation/activation stays blocked at file entry.
-- Shared existing-lease proof, private and non-mutating; no new public authority.
CREATE FUNCTION app.native_attempt_value_owner(p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_node app.node_runs%ROWTYPE;
  v_attempt app.node_attempts%ROWTYPE;
  v_delivery app.outbox_events%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_path uuid[];
  v_depths integer[]:=ARRAY[]::integer[];
  v_current uuid;
  v_root uuid;
  v_deadline timestamptz;
  v_index integer;
  v_sites integer;
  v_payload_text text;
BEGIN
  IF (v_workspace IS NOT NULL AND jsonb_typeof(p_authority)='object'
    AND p_authority ?& ARRAY['runId','workflowVersionId','nodeRunId','attemptId',
      'attemptNumber','invocationKey','nodeId','workerId','fenceToken','delivery']
    AND p_authority-ARRAY['runId','workflowVersionId','nodeRunId','attemptId',
      'attemptNumber','invocationKey','nodeId','workerId','fenceToken','delivery']='{}'::jsonb
    AND jsonb_typeof(p_authority->'delivery')='object'
    AND p_authority->'delivery' ?& ARRAY['outboxEventId','payloadChecksum']
    AND (p_authority->'delivery')-ARRAY['outboxEventId','payloadChecksum']='{}'::jsonb
    AND p_authority#>>'{delivery,payloadChecksum}' ~ '^[0-9a-f]{64}$'
    AND p_authority->>'workerId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    AND p_authority->>'nodeId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND octet_length(p_authority->>'invocationKey') BETWEEN 1 AND 256
    AND (p_authority->>'attemptNumber')::integer>0
    AND (p_authority->>'fenceToken')::bigint>0) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid native attempt value owner context' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace AND workspace.status='active') THEN
    RAISE EXCEPTION 'native attempt value workspace is not active' USING ERRCODE='55000';
  END IF;
  v_current:=(p_authority->>'runId')::uuid;
  PERFORM app.assert_native_call_detail_live(v_current);
  v_path:=ARRAY[v_current];
  LOOP
    SELECT * INTO v_call FROM app.workflow_calls call
      WHERE call.workspace_id=v_workspace AND call.child_run_id=v_current
        AND call.outcome_kind='admitted' AND call.sealed;
    IF NOT FOUND THEN EXIT; END IF;
    IF array_length(v_path,1)>=5 OR v_call.parent_run_id=ANY(v_path)
      OR (v_root IS NOT NULL AND v_root<>v_call.root_run_id) THEN
      RAISE EXCEPTION 'native attempt value lineage is invalid' USING ERRCODE='23514';
    END IF;
    v_root:=v_call.root_run_id;
    v_depths:=array_append(v_depths,v_call.call_depth);
    v_current:=v_call.parent_run_id;
    v_path:=array_append(v_path,v_current);
  END LOOP;
  IF v_root IS NOT NULL AND v_current<>v_root THEN
    RAISE EXCEPTION 'native attempt value root lineage differs' USING ERRCODE='23514';
  END IF;
  FOR v_index IN REVERSE array_length(v_path,1)..1 LOOP
    SELECT * INTO v_run FROM app.workflow_runs run
      WHERE run.workspace_id=v_workspace AND run.id=v_path[v_index];
    -- A logical Call wait keeps the ancestor live while its child executes.
    -- Only the CURRENT attempt's run must be running below; an ancestor's
    -- legitimate waiting state must not deny its admitted child's input.
    IF NOT FOUND OR v_run.status NOT IN ('queued','running','waiting')
      OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at IS NULL
      OR NOT isfinite(v_run.deadline_at) OR v_run.deadline_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'native attempt value run controls are active or unavailable' USING ERRCODE='55000';
    END IF;
    IF (v_index=array_length(v_path,1) AND v_run.trigger_type='workflow_call')
      OR (v_index<array_length(v_path,1) AND v_run.trigger_type<>'workflow_call') THEN
      RAISE EXCEPTION 'native attempt value canonical child lineage is unavailable' USING ERRCODE='55000';
    END IF;
    v_deadline:=least(v_deadline,v_run.deadline_at);
    IF v_index<array_length(v_path,1)
      AND v_depths[v_index]<>array_length(v_path,1)-v_index THEN
      RAISE EXCEPTION 'native attempt value depth differs' USING ERRCODE='23514';
    END IF;
  END LOOP;
  -- The last iteration is the actual consuming/producing run, not its ancestor.
  IF v_run.workflow_version_id<>(p_authority->>'workflowVersionId')::uuid
    OR v_run.status<>'running' THEN
    RAISE EXCEPTION 'native attempt value version or run state differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_version FROM app.workflow_versions version
    WHERE version.workspace_id=v_workspace AND version.id=v_run.workflow_version_id;
  IF NOT FOUND OR v_version.schema_version IS DISTINCT FROM 2
    OR v_version.executable_schema_version IS DISTINCT FROM 3
    OR v_version.executable_json IS NULL
    OR (v_version.checksum ~ '^wf:v3:sha256:[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native attempt value executable is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_node FROM app.node_runs node
    WHERE node.workspace_id=v_workspace AND node.id=(p_authority->>'nodeRunId')::uuid
      AND node.workflow_run_id=v_run.id;
  IF NOT FOUND OR v_node.node_id<>p_authority->>'nodeId'
    OR v_node.invocation_key<>p_authority->>'invocationKey'
    OR v_node.status<>'running'
    OR v_node.current_attempt_id IS DISTINCT FROM (p_authority->>'attemptId')::uuid
    OR v_node.current_attempt_number IS DISTINCT FROM (p_authority->>'attemptNumber')::integer THEN
    RAISE EXCEPTION 'native attempt value invocation is not current' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_attempt FROM app.node_attempts attempt
    WHERE attempt.workspace_id=v_workspace AND attempt.node_run_id=v_node.id
      AND attempt.id=(p_authority->>'attemptId')::uuid;
  IF NOT FOUND OR v_attempt.attempt_number<>(p_authority->>'attemptNumber')::integer
    OR v_attempt.status<>'running' OR v_attempt.lease_owner IS DISTINCT FROM p_authority->>'workerId'
    OR v_attempt.fence_token<>(p_authority->>'fenceToken')::bigint
    OR v_attempt.lease_expires_at IS NULL OR NOT isfinite(v_attempt.lease_expires_at)
    OR v_attempt.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'native attempt value lease is not current' USING ERRCODE='55000';
  END IF;
  WITH RECURSIVE graphs(graph,depth) AS (
    SELECT v_version.executable_json->'graph',1 UNION ALL
    SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
      WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
  ) SELECT count(*)::integer INTO v_sites FROM graphs
    CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
    WHERE node->>'id'=v_node.node_id;
  IF v_sites<>1 THEN
    RAISE EXCEPTION 'native attempt immutable node identity differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_delivery FROM app.outbox_events event
    WHERE event.workspace_id=v_workspace
      AND event.id=(p_authority#>>'{delivery,outboxEventId}')::uuid;
  IF NOT FOUND OR (v_delivery.aggregate_id=v_attempt.id
    AND v_delivery.aggregate_type='node-attempt' AND v_delivery.job_name='execute-node-attempt'
    AND v_delivery.schema_version=1
    AND v_delivery.payload_checksum=p_authority#>>'{delivery,payloadChecksum}'
    AND v_delivery.payload->'schemaVersion'='1'::jsonb
    AND v_delivery.payload->>'workspaceId'=v_workspace::text
    AND v_delivery.payload->>'runId'=v_run.id::text
    AND v_delivery.payload->>'nodeRunId'=v_node.id::text
    AND v_delivery.payload->>'attemptId'=v_attempt.id::text
    AND v_delivery.payload->>'outboxEventId'=v_delivery.id::text
    AND v_delivery.payload-ARRAY['schemaVersion','workspaceId','runId','nodeRunId',
      'attemptId','outboxEventId','traceparent']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native attempt value canonical delivery differs' USING ERRCODE='55000';
  END IF;
  -- Fixed existing attempt-job grammar: UUID strings and optional validated
  -- traceparent only. This is not a generic JSON/JavaScript encoder.
  v_payload_text:='{"attemptId":"'||v_attempt.id::text||'","nodeRunId":"'||v_node.id::text
    ||'","outboxEventId":"'||v_delivery.id::text||'","runId":"'||v_run.id::text||'","schemaVersion":1';
  IF v_delivery.payload ? 'traceparent' THEN
    IF (v_delivery.payload->>'traceparent' ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'native attempt value delivery trace is invalid' USING ERRCODE='22023';
    END IF;
    v_payload_text:=v_payload_text||',"traceparent":"'||(v_delivery.payload->>'traceparent')||'"';
  END IF;
  v_payload_text:=v_payload_text||',"workspaceId":"'||v_workspace::text||'"}';
  IF encode(sha256(convert_to(v_payload_text,'UTF8')),'hex')<>v_delivery.payload_checksum
    OR NOT EXISTS (SELECT 1 FROM app.inbox_receipts receipt
      WHERE receipt.workspace_id=v_workspace AND receipt.consumer_name='node-attempt-worker'
        AND receipt.message_id=v_delivery.id AND receipt.payload_checksum=v_delivery.payload_checksum
        AND receipt.completed_at IS NULL) THEN
    RAISE EXCEPTION 'native attempt value delivery receipt is unavailable' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('workspaceId',v_workspace,'runId',v_run.id,
    'workflowVersionId',v_run.workflow_version_id,'nodeRunId',v_node.id,'nodeId',v_node.node_id,
    'invocationKey',v_node.invocation_key,'attemptId',v_attempt.id,'attemptNumber',v_attempt.attempt_number,
    'leaseExpiresAt',v_attempt.lease_expires_at,'deadlineAt',v_deadline);
END $$;
REVOKE ALL ON FUNCTION app.native_attempt_value_owner(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

-- Private write ordering wraps the SAME independently checked real lease proof.
-- Read owners call native_attempt_value_owner without acquiring write locks.
CREATE FUNCTION app.lock_native_attempt_value_owner(p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.native_attempt_value_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_path uuid[];
  v_index integer;
BEGIN
  IF app.lock_workspace_run_admission(v_workspace) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'native attempt workspace is not active' USING ERRCODE='55000';
  END IF;
  v_path:=app.native_call_lineage((v_scope->>'runId')::uuid);
  FOR v_index IN REVERSE cardinality(v_path)..1 LOOP
    PERFORM 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
      AND run.id=v_path[v_index] FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'native attempt ancestor is missing' USING ERRCODE='55000'; END IF;
  END LOOP;
  PERFORM 1 FROM app.inbox_receipts receipt WHERE receipt.workspace_id=v_workspace
    AND receipt.consumer_name='node-attempt-worker'
    AND receipt.message_id=(p_authority#>>'{delivery,outboxEventId}')::uuid FOR UPDATE;
  PERFORM 1 FROM app.node_runs node WHERE node.workspace_id=v_workspace
    AND node.id=(v_scope->>'nodeRunId')::uuid FOR UPDATE;
  PERFORM 1 FROM app.node_attempts attempt WHERE attempt.workspace_id=v_workspace
    AND attempt.id=(v_scope->>'attemptId')::uuid FOR UPDATE;
  IF app.native_call_lineage((v_scope->>'runId')::uuid) IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'native attempt locked lineage changed' USING ERRCODE='55000';
  END IF;
  -- Recheck canonical delivery, receipt, current lease/fence/version and clocks
  -- AFTER all ancestor-first locks, not from the preliminary read projection.
  RETURN app.native_attempt_value_owner(p_authority);
END $$;
REVOKE ALL ON FUNCTION app.lock_native_attempt_value_owner(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

CREATE FUNCTION app.lock_native_call_input_owner(p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.lock_native_attempt_value_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_version app.workflow_versions%ROWTYPE;
  v_node app.node_runs%ROWTYPE;
  v_sites integer;
  v_pin jsonb;
BEGIN
  SELECT * INTO STRICT v_version FROM app.workflow_versions version
    WHERE version.workspace_id=v_workspace AND version.id=(v_scope->>'workflowVersionId')::uuid;
  SELECT * INTO STRICT v_node FROM app.node_runs node
    WHERE node.workspace_id=v_workspace AND node.id=(v_scope->>'nodeRunId')::uuid;
  WITH RECURSIVE graphs(graph,depth) AS (
    SELECT v_version.executable_json->'graph',1
    UNION ALL
    SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
      WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
  ), sites AS (
    SELECT node FROM graphs CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
    WHERE node->>'id'=v_node.node_id
      AND node#>>'{definition,key}'='core.workflow_call'
      AND node#>'{definition,version}'='1'::jsonb
  ) SELECT count(*)::integer,(jsonb_agg(node->'config'))->0 INTO v_sites,v_pin FROM sites;
  -- Ambiguous nested node identities fail operationally, not guessed by scanning
  -- a reference-shaped payload. Exact structured invocation resolution remains
  -- a review assumption until compiler/loader qualification establishes it.
  IF v_sites<>1 OR (v_pin-ARRAY['workflowId','versionId','checksum','callableContractIdentity'])<>'{}'::jsonb
    OR (v_pin->>'checksum' ~ '^wf:v3:sha256:[0-9a-f]{64}$') IS NOT TRUE
    OR (v_pin->>'callableContractIdentity' ~ '^callable:v1:sha256:[0-9a-f]{64}$') IS NOT TRUE
    OR NOT EXISTS (SELECT 1 FROM app.workflow_versions callee
      WHERE callee.workspace_id=v_workspace AND callee.workflow_id=(v_pin->>'workflowId')::uuid
        AND callee.id=(v_pin->>'versionId')::uuid AND callee.checksum=v_pin->>'checksum'
        AND callee.schema_version=2 AND callee.executable_schema_version=3) THEN
    RAISE EXCEPTION 'native Call input immutable declaration is unavailable' USING ERRCODE='55000';
  END IF;
  RETURN v_scope;
END $$;
REVOKE ALL ON FUNCTION app.lock_native_call_input_owner(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

-- Existing completion caller enters this before receipt/current descendant
-- locks; it returns no authority token or receipt and accepts only its real lease.
CREATE FUNCTION app.prelock_native_attempt_value_owner(p_authority jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  PERFORM app.lock_native_attempt_value_owner(p_authority);
END $$;
REVOKE ALL ON FUNCTION app.prelock_native_attempt_value_owner(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.prelock_native_attempt_value_owner(jsonb) TO {{worker_runtime_role}};

CREATE FUNCTION app.record_native_workflow_attempt_output(
  p_authority jsonb,p_reference jsonb,p_sha256 text,p_byte_length integer,p_original text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.lock_native_attempt_value_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_existing app.workflow_execution_value_provenance%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_accepted timestamptz;
BEGIN
  IF (jsonb_typeof(p_reference)='object' AND p_reference->'schemaVersion'='1'::jsonb
    AND p_reference->>'kind'='inline' AND p_reference ? 'value'
    AND p_reference-ARRAY['schemaVersion','kind','value']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native physical inline output envelope differs' USING ERRCODE='22023';
  END IF;
  PERFORM app.assert_native_inline_execution_value_bytes(p_reference->'value',p_sha256,p_byte_length,p_original);
  SELECT * INTO STRICT v_version FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.id=(v_scope->>'workflowVersionId')::uuid;
  IF EXISTS(WITH RECURSIVE graphs(graph,depth) AS (
    SELECT v_version.executable_json->'graph',1 UNION ALL
    SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
      WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
  ) SELECT 1 FROM graphs CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
    WHERE node->>'id'=v_scope->>'nodeId' AND node#>>'{definition,key}'='core.workflow_call') THEN
    RAISE EXCEPTION 'native Call physical output must alias accepted declaration input' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_existing FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=v_workspace AND source.value_slot='attempt_output'
      AND source.attempt_id=(v_scope->>'attemptId')::uuid;
  IF FOUND THEN
    IF (v_existing.byte_ownership='owned' AND v_existing.workflow_run_id=(v_scope->>'runId')::uuid
      AND v_existing.workflow_version_id=(v_scope->>'workflowVersionId')::uuid
      AND v_existing.node_run_id=(v_scope->>'nodeRunId')::uuid AND v_existing.node_id=v_scope->>'nodeId'
      AND v_existing.invocation_key=v_scope->>'invocationKey'
      AND v_existing.attempt_number=(v_scope->>'attemptNumber')::integer
      AND v_existing.reference_kind='inline' AND v_existing.original_reference::text=p_reference::text
      AND v_existing.original_inline_text=p_original AND v_existing.sha256=p_sha256
      AND v_existing.byte_length=p_byte_length AND v_existing.eligibility_revoked_at IS NULL
      AND v_existing.eligible_until>clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'native physical output first immutable bytes differ' USING ERRCODE='55000';
    END IF;
  ELSE
    v_accepted:=clock_timestamp();
    INSERT INTO app.workflow_execution_value_provenance(
      id,workspace_id,workflow_run_id,workflow_version_id,value_slot,byte_ownership,
      node_run_id,node_id,invocation_key,attempt_id,attempt_number,
      reference_kind,original_reference,original_inline_text,sha256,byte_length,media_type,
      accepted_at,eligible_until
    ) VALUES(gen_random_uuid(),v_workspace,(v_scope->>'runId')::uuid,(v_scope->>'workflowVersionId')::uuid,
      'attempt_output','owned',(v_scope->>'nodeRunId')::uuid,v_scope->>'nodeId',v_scope->>'invocationKey',
      (v_scope->>'attemptId')::uuid,(v_scope->>'attemptNumber')::integer,
      'inline',p_reference,p_original,p_sha256,p_byte_length,
      'application/vnd.pertexo.execution-value+json;version=1',v_accepted,v_accepted+interval '30 days');
  END IF;
  -- The existing physical completion writes and receipt complete in this same
  -- transaction. This producer never settles a run, invents replay or charges quota.
  PERFORM app.native_attempt_value_owner(p_authority);
END $$;
REVOKE ALL ON FUNCTION app.record_native_workflow_attempt_output(jsonb,jsonb,text,integer,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.record_native_workflow_attempt_output(jsonb,jsonb,text,integer,text)
  TO {{worker_runtime_role}};

CREATE FUNCTION app.record_workflow_call_declaration_input(
  p_authority jsonb,p_reference jsonb,p_sha256 text,p_byte_length integer,p_original text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.lock_native_call_input_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_existing app.workflow_execution_value_provenance%ROWTYPE;
  v_candidate app.workflow_execution_value_artifact_candidates%ROWTYPE;
  v_artifact app.artifacts%ROWTYPE;
  v_id uuid;
  v_accepted_at timestamptz;
  v_eligible_until timestamptz;
BEGIN
  IF (jsonb_typeof(p_reference)='object' AND p_reference->'schemaVersion'='1'::jsonb
    AND p_sha256 ~ '^[0-9a-f]{64}$' AND p_byte_length BETWEEN 1 AND 1048576
    AND octet_length(p_reference::text)<=4194304 AND (
      (p_reference->>'kind'='inline' AND p_reference ? 'value'
        AND p_reference-ARRAY['kind','schemaVersion','value']='{}'::jsonb AND p_original IS NOT NULL)
      OR (p_reference->>'kind'='artifact' AND p_reference ? 'artifactId'
        AND p_reference-ARRAY['kind','schemaVersion','artifactId']='{}'::jsonb AND p_original IS NULL)
    )) IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call input reference is invalid' USING ERRCODE='22023';
  END IF;
  IF p_reference->>'kind'='inline' THEN
    PERFORM app.assert_native_inline_execution_value_bytes(
      p_reference->'value',p_sha256,p_byte_length,p_original);
  ELSE
    SELECT * INTO v_candidate FROM app.workflow_execution_value_artifact_candidates candidate
      WHERE candidate.workspace_id=v_workspace AND candidate.value_slot='attempt_input'
        AND candidate.attempt_id=(v_scope->>'attemptId')::uuid FOR UPDATE;
    IF NOT FOUND OR (v_candidate.workflow_run_id=(v_scope->>'runId')::uuid
      AND v_candidate.workflow_version_id=(v_scope->>'workflowVersionId')::uuid
      AND v_candidate.node_run_id=(v_scope->>'nodeRunId')::uuid
      AND v_candidate.node_id=v_scope->>'nodeId' AND v_candidate.invocation_key=v_scope->>'invocationKey'
      AND v_candidate.attempt_number=(v_scope->>'attemptNumber')::integer
      AND v_candidate.artifact_id=(p_reference->>'artifactId')::uuid
      AND v_candidate.sha256=p_sha256 AND v_candidate.byte_length=p_byte_length
      AND v_candidate.abandoned_at IS NULL) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call input exact artifact candidate is unavailable' USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT * INTO v_existing FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.value_slot='attempt_input'
      AND provenance.attempt_id=(v_scope->>'attemptId')::uuid FOR UPDATE;
  v_id:=v_existing.id;
  IF p_reference->>'kind'='artifact' THEN
    SELECT * INTO v_artifact FROM app.artifacts artifact
      WHERE artifact.workspace_id=v_workspace AND artifact.id=v_candidate.artifact_id FOR UPDATE;
    IF NOT FOUND OR (v_artifact.status='available' AND v_artifact.deleted_at IS NULL
      AND v_artifact.expires_at>clock_timestamp() AND isfinite(v_artifact.expires_at)
      AND v_artifact.purpose='execution-value' AND v_artifact.sha256=p_sha256
      AND v_artifact.byte_length=p_byte_length
      AND v_artifact.media_type='application/vnd.pertexo.execution-value+json;version=1') IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call input artifact is not available' USING ERRCODE='55000';
    END IF;
  END IF;
  IF v_id IS NOT NULL THEN
    IF (v_existing.workflow_run_id=(v_scope->>'runId')::uuid
      AND v_existing.workflow_version_id=(v_scope->>'workflowVersionId')::uuid
      AND v_existing.node_run_id=(v_scope->>'nodeRunId')::uuid
      AND v_existing.node_id=v_scope->>'nodeId' AND v_existing.invocation_key=v_scope->>'invocationKey'
      AND v_existing.attempt_number=(v_scope->>'attemptNumber')::integer
      AND v_existing.byte_ownership='owned'
      AND v_existing.reference_kind=p_reference->>'kind'
      AND v_existing.sha256=p_sha256 AND v_existing.byte_length=p_byte_length
      AND v_existing.eligibility_revoked_at IS NULL AND v_existing.eligible_until>clock_timestamp()
      AND v_existing.original_inline_text IS NOT DISTINCT FROM p_original) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call input immutable identity differs' USING ERRCODE='23514';
    END IF;
    IF p_reference->>'kind'='inline' THEN
      -- Preserve FIRST normalized projection, even when a replay presents an
      -- equivalent rounded reference. Both projections must agree with the
      -- same exact original bytes; no historical re-encoding changes identity.
      PERFORM app.assert_native_inline_execution_value_bytes(
        v_existing.original_reference->'value',p_sha256,p_byte_length,p_original);
    ELSIF v_existing.artifact_id IS DISTINCT FROM v_candidate.artifact_id
      OR NOT EXISTS (SELECT 1 FROM app.workflow_execution_value_artifact_associations association
        WHERE association.workspace_id=v_workspace AND association.provenance_id=v_id
          AND association.candidate_id=v_candidate.id) THEN
      RAISE EXCEPTION 'native Call input accepted artifact association differs' USING ERRCODE='23514';
    END IF;
  ELSE
    v_id:=gen_random_uuid();
    v_accepted_at:=clock_timestamp();
    v_eligible_until:=v_accepted_at+interval '30 days';
    IF p_reference->>'kind'='artifact' THEN
      v_eligible_until:=least(v_eligible_until,v_artifact.expires_at);
    END IF;
    INSERT INTO app.workflow_execution_value_provenance (
      id,workspace_id,workflow_run_id,workflow_version_id,value_slot,byte_ownership,
      node_run_id,node_id,invocation_key,attempt_id,attempt_number,reference_kind,
      original_reference,original_inline_text,artifact_id,sha256,byte_length,media_type,
      accepted_at,eligible_until
    ) VALUES (
      v_id,v_workspace,(v_scope->>'runId')::uuid,(v_scope->>'workflowVersionId')::uuid,
      'attempt_input','owned',(v_scope->>'nodeRunId')::uuid,v_scope->>'nodeId',v_scope->>'invocationKey',
      (v_scope->>'attemptId')::uuid,(v_scope->>'attemptNumber')::integer,p_reference->>'kind',
      p_reference,p_original,v_candidate.artifact_id,p_sha256,p_byte_length,
      'application/vnd.pertexo.execution-value+json;version=1',v_accepted_at,v_eligible_until
    );
    IF p_reference->>'kind'='artifact' THEN
      INSERT INTO app.workflow_execution_value_artifact_associations (
        workspace_id,provenance_id,candidate_id,workflow_run_id,workflow_version_id,value_slot,
        node_run_id,node_id,invocation_key,attempt_id,attempt_number,artifact_id,
        sha256,byte_length,media_type,accepted_at
      ) VALUES (
        v_workspace,v_id,v_candidate.id,(v_scope->>'runId')::uuid,(v_scope->>'workflowVersionId')::uuid,
        'attempt_input',(v_scope->>'nodeRunId')::uuid,v_scope->>'nodeId',v_scope->>'invocationKey',
        (v_scope->>'attemptId')::uuid,(v_scope->>'attemptNumber')::integer,v_candidate.artifact_id,
        p_sha256,p_byte_length,'application/vnd.pertexo.execution-value+json;version=1',v_accepted_at
      );
    END IF;
  END IF;
  -- The required input owner, not the optional diagnostic writer, binds the
  -- node to FIRST accepted projection. Replays cannot replace it with another
  -- rounded projection; admission/completion consume this same durable value.
  SELECT * INTO v_existing FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.id=v_id;
  UPDATE app.node_runs node SET input_ref=v_existing.original_reference,updated_at=clock_timestamp()
    WHERE node.workspace_id=v_workspace AND node.id=(v_scope->>'nodeRunId')::uuid
      AND node.workflow_run_id=(v_scope->>'runId')::uuid
      AND node.node_id=v_scope->>'nodeId' AND node.invocation_key=v_scope->>'invocationKey'
      AND (node.input_ref IS NULL OR node.input_ref::text=v_existing.original_reference::text);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native Call node first input differs' USING ERRCODE='23514';
  END IF;
  IF (v_scope->>'leaseExpiresAt')::timestamptz<=clock_timestamp()
    OR (v_scope->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'native Call input ownership expired during record' USING ERRCODE='55000';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.record_workflow_call_declaration_input(jsonb,jsonb,text,integer,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Retain the optional diagnostic writer for ordinary nodes. Once a required
-- Call input is accepted, that writer cannot replace FIRST projection. Clearing
-- it belongs to retention only after the exact provenance is revoked; expiry
-- alone is not permission to mutate accepted physical identity.
CREATE FUNCTION app.guard_native_call_node_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_input app.workflow_execution_value_provenance%ROWTYPE;
BEGIN
  SELECT * INTO v_input FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=OLD.workspace_id AND provenance.node_run_id=OLD.id
      AND provenance.value_slot='attempt_input' AND provenance.byte_ownership='owned';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.input_ref::text IS NOT DISTINCT FROM v_input.original_reference::text THEN RETURN NEW; END IF;
  IF NEW.input_ref IS NULL AND v_input.eligibility_revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'accepted native Call node input is immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.guard_native_call_node_input()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE TRIGGER native_call_node_input_immutable BEFORE UPDATE OF input_ref ON app.node_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_native_call_node_input();

CREATE FUNCTION app.read_workflow_call_declaration_input(p_authority jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.lock_native_call_input_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_provenance app.workflow_execution_value_provenance%ROWTYPE;
  v_candidate app.workflow_execution_value_artifact_candidates%ROWTYPE;
  v_artifact app.artifacts%ROWTYPE;
  v_snapshot jsonb;
BEGIN
  SELECT candidate.* INTO v_candidate FROM app.workflow_execution_value_artifact_candidates candidate
    JOIN app.workflow_execution_value_artifact_associations association
      ON association.workspace_id=candidate.workspace_id AND association.candidate_id=candidate.id
    WHERE candidate.workspace_id=v_workspace AND candidate.value_slot='attempt_input'
      AND candidate.attempt_id=(v_scope->>'attemptId')::uuid FOR SHARE OF candidate;
  SELECT * INTO v_provenance FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.value_slot='attempt_input'
      AND provenance.attempt_id=(v_scope->>'attemptId')::uuid FOR SHARE;
  IF FOUND THEN
    IF (v_provenance.workflow_run_id=(v_scope->>'runId')::uuid
      AND v_provenance.workflow_version_id=(v_scope->>'workflowVersionId')::uuid
      AND v_provenance.node_run_id=(v_scope->>'nodeRunId')::uuid
      AND v_provenance.node_id=v_scope->>'nodeId'
      AND v_provenance.invocation_key=v_scope->>'invocationKey'
      AND v_provenance.attempt_number=(v_scope->>'attemptNumber')::integer
      AND v_provenance.byte_ownership='owned' AND v_provenance.eligibility_revoked_at IS NULL
      AND v_provenance.eligible_until>clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call input snapshot is not eligible' USING ERRCODE='55000';
    END IF;
    IF v_provenance.reference_kind='inline' THEN
      PERFORM app.assert_native_inline_execution_value_bytes(v_provenance.original_reference->'value',
        v_provenance.sha256,v_provenance.byte_length,v_provenance.original_inline_text);
    ELSE
      SELECT * INTO v_artifact FROM app.artifacts artifact
        WHERE artifact.workspace_id=v_workspace AND artifact.id=v_provenance.artifact_id FOR SHARE;
      IF NOT FOUND OR (v_candidate.id IS NOT NULL AND v_candidate.abandoned_at IS NULL
        AND v_candidate.artifact_id=v_artifact.id AND v_artifact.status='available'
        AND v_artifact.deleted_at IS NULL AND v_artifact.expires_at>clock_timestamp()
        AND v_artifact.sha256=v_provenance.sha256 AND v_artifact.byte_length=v_provenance.byte_length
        AND v_artifact.media_type=v_provenance.media_type AND v_artifact.purpose='execution-value') IS NOT TRUE THEN
        RAISE EXCEPTION 'native Call input snapshot artifact is unavailable' USING ERRCODE='55000';
      END IF;
    END IF;
    v_snapshot:=jsonb_build_object('reference',v_provenance.original_reference,
      'sha256',v_provenance.sha256,'byteLength',v_provenance.byte_length);
    IF v_provenance.reference_kind='inline' THEN
      v_snapshot:=v_snapshot||jsonb_build_object('serializedValue',v_provenance.original_inline_text);
    END IF;
  END IF;
  IF (v_scope->>'leaseExpiresAt')::timestamptz<=clock_timestamp()
    OR (v_scope->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'native Call input ownership expired during read' USING ERRCODE='55000';
  END IF;
  RETURN v_snapshot;
END $$;
REVOKE ALL ON FUNCTION app.read_workflow_call_declaration_input(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- EXISTING physical completion alias getter. The actual TypeScript completion
-- owner calls this BEFORE its receipt/current-run/node/attempt locks. Only
-- ancestors are prelocked first; the ordinary receipt -> current run -> node
-- -> attempt order is preserved. No new transport/prelock authority is added.
-- Completed replay deliberately does NOT call the live-input owner: cleared
-- leases and a logical child wait/result are not a lost physical completion.
CREATE FUNCTION app.workflow_call_declaration_completion_reference(p_authority jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_ancestor app.workflow_runs%ROWTYPE;
  v_node app.node_runs%ROWTYPE;
  v_attempt app.node_attempts%ROWTYPE;
  v_receipt app.inbox_receipts%ROWTYPE;
  v_delivery app.outbox_events%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_provenance app.workflow_execution_value_provenance%ROWTYPE;
  v_candidate app.workflow_execution_value_artifact_candidates%ROWTYPE;
  v_artifact app.artifacts%ROWTYPE;
  v_path uuid[];
  v_depths integer[]:=ARRAY[]::integer[];
  v_current uuid;
  v_root uuid;
  v_index integer;
  v_sites integer;
  v_pin jsonb;
  v_scope jsonb;
  v_payload_text text;
  v_replay boolean;
BEGIN
  IF (v_workspace IS NOT NULL AND jsonb_typeof(p_authority)='object'
    AND p_authority ?& ARRAY['runId','workflowVersionId','nodeRunId','attemptId',
      'attemptNumber','invocationKey','nodeId','workerId','fenceToken','delivery']
    AND p_authority-ARRAY['runId','workflowVersionId','nodeRunId','attemptId',
      'attemptNumber','invocationKey','nodeId','workerId','fenceToken','delivery']='{}'::jsonb
    AND jsonb_typeof(p_authority->'delivery')='object'
    AND p_authority->'delivery' ?& ARRAY['outboxEventId','payloadChecksum']
    AND (p_authority->'delivery')-ARRAY['outboxEventId','payloadChecksum']='{}'::jsonb
    AND p_authority#>>'{delivery,payloadChecksum}' ~ '^[0-9a-f]{64}$'
    AND p_authority->>'workerId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    AND p_authority->>'nodeId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND octet_length(p_authority->>'invocationKey') BETWEEN 1 AND 256
    AND (p_authority->>'attemptNumber')::integer>0
    AND (p_authority->>'fenceToken')::bigint>0) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid native Call completion context' USING ERRCODE='22023';
  END IF;
  IF app.lock_workspace_run_admission(v_workspace) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'native Call completion workspace is unavailable' USING ERRCODE='55000';
  END IF;
  v_current:=(p_authority->>'runId')::uuid;
  PERFORM app.assert_native_call_detail_live(v_current);
  v_path:=ARRAY[v_current];
  LOOP
    SELECT * INTO v_call FROM app.workflow_calls call
      WHERE call.workspace_id=v_workspace AND call.child_run_id=v_current
        AND call.outcome_kind='admitted' AND call.sealed;
    IF NOT FOUND THEN EXIT; END IF;
    IF array_length(v_path,1)>=5 OR v_call.parent_run_id=ANY(v_path)
      OR (v_root IS NOT NULL AND v_root<>v_call.root_run_id) THEN
      RAISE EXCEPTION 'native Call completion lineage is invalid' USING ERRCODE='23514';
    END IF;
    v_root:=v_call.root_run_id;
    v_depths:=array_append(v_depths,v_call.call_depth);
    v_current:=v_call.parent_run_id;
    v_path:=array_append(v_path,v_current);
  END LOOP;
  IF v_root IS NOT NULL AND v_current<>v_root THEN
    RAISE EXCEPTION 'native Call completion root lineage differs' USING ERRCODE='23514';
  END IF;
  IF array_length(v_path,1)>1 THEN
    FOR v_index IN REVERSE array_length(v_path,1)..2 LOOP
      SELECT * INTO v_ancestor FROM app.workflow_runs run
        WHERE run.workspace_id=v_workspace AND run.id=v_path[v_index] FOR SHARE;
      IF NOT FOUND OR (v_index=array_length(v_path,1) AND v_ancestor.trigger_type='workflow_call')
        OR (v_index<array_length(v_path,1) AND v_ancestor.trigger_type<>'workflow_call')
        OR v_depths[v_index-1]<>array_length(v_path,1)-v_index+1 THEN
        RAISE EXCEPTION 'native Call completion ancestor differs' USING ERRCODE='55000';
      END IF;
      -- Do not inspect live controls here: an actual physical replay remains a
      -- replay after logical completion/cancellation. The live branch below
      -- rechecks controls while these same ancestor locks are already held.
    END LOOP;
  END IF;
  SELECT * INTO v_receipt FROM app.inbox_receipts receipt
    WHERE receipt.workspace_id=v_workspace AND receipt.consumer_name='node-attempt-worker'
      AND receipt.message_id=(p_authority#>>'{delivery,outboxEventId}')::uuid FOR UPDATE;
  IF NOT FOUND OR v_receipt.payload_checksum IS DISTINCT FROM p_authority#>>'{delivery,payloadChecksum}' THEN
    RAISE EXCEPTION 'native Call completion receipt differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs run
    WHERE run.workspace_id=v_workspace AND run.id=(p_authority->>'runId')::uuid
      AND run.workflow_version_id=(p_authority->>'workflowVersionId')::uuid FOR UPDATE;
  IF NOT FOUND OR (array_length(v_path,1)=1 AND v_run.trigger_type='workflow_call')
    OR (array_length(v_path,1)>1 AND v_run.trigger_type<>'workflow_call') THEN
    RAISE EXCEPTION 'native Call completion run differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_node FROM app.node_runs node
    WHERE node.workspace_id=v_workspace AND node.id=(p_authority->>'nodeRunId')::uuid
      AND node.workflow_run_id=v_run.id FOR UPDATE;
  IF NOT FOUND OR v_node.node_id IS DISTINCT FROM p_authority->>'nodeId'
    OR v_node.invocation_key IS DISTINCT FROM p_authority->>'invocationKey' THEN
    RAISE EXCEPTION 'native Call completion invocation differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_attempt FROM app.node_attempts attempt
    WHERE attempt.workspace_id=v_workspace AND attempt.node_run_id=v_node.id
      AND attempt.id=(p_authority->>'attemptId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_attempt.attempt_number IS DISTINCT FROM (p_authority->>'attemptNumber')::integer
    OR v_attempt.fence_token IS DISTINCT FROM (p_authority->>'fenceToken')::bigint THEN
    RAISE EXCEPTION 'native Call completion attempt differs' USING ERRCODE='55000';
  END IF;
  v_replay:=v_attempt.status='succeeded';
  IF v_replay THEN
    IF (v_attempt.completed_at IS NOT NULL AND v_attempt.lease_owner IS NULL
      AND v_attempt.lease_expires_at IS NULL AND v_attempt.output_ref IS NOT NULL
      AND v_attempt.safe_error_code IS NULL AND v_attempt.error_summary IS NULL
      AND v_attempt.executor_failure_kind IS NULL AND v_attempt.executor_error_kind IS NULL
      AND v_attempt.executor_possibly_dispatched IS NULL AND v_attempt.retry_decision IS NULL
      AND v_node.status IN ('waiting','succeeded','failed','canceled','timed_out','outcome_unknown')
      AND EXISTS (SELECT 1 FROM app.run_events event
        WHERE event.workspace_id=v_workspace AND event.workflow_run_id=v_run.id
          AND event.type='node.succeeded' AND event.payload->'schemaVersion'='1'::jsonb
          AND event.payload->>'nodeRunId'=v_node.id::text
          AND event.payload->>'attemptId'=v_attempt.id::text
          AND event.payload->>'nodeId'=v_node.node_id
          AND event.payload->>'invocationKey'=v_node.invocation_key
          AND event.payload->'attemptNumber'=to_jsonb(v_attempt.attempt_number)
          AND event.payload-ARRAY['schemaVersion','nodeRunId','attemptId','nodeId',
            'invocationKey','attemptNumber']='{}'::jsonb)) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call completion physical replay differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_version FROM app.workflow_versions version
      WHERE version.workspace_id=v_workspace AND version.id=v_run.workflow_version_id;
    IF NOT FOUND OR v_version.schema_version IS DISTINCT FROM 2
      OR v_version.executable_schema_version IS DISTINCT FROM 3 OR v_version.executable_json IS NULL THEN
      RAISE EXCEPTION 'native Call completion executable is unavailable' USING ERRCODE='55000';
    END IF;
    WITH RECURSIVE graphs(graph,depth) AS (
      SELECT v_version.executable_json->'graph',1
      UNION ALL
      SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
        CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
        WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
    ), sites AS (
      SELECT node FROM graphs CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
      WHERE node->>'id'=v_node.node_id AND node#>>'{definition,key}'='core.workflow_call'
        AND node#>'{definition,version}'='1'::jsonb
    ) SELECT count(*)::integer,(jsonb_agg(node->'config'))->0 INTO v_sites,v_pin FROM sites;
    IF v_sites<>1 OR (v_pin-ARRAY['workflowId','versionId','checksum','callableContractIdentity'])<>'{}'::jsonb
      OR (v_pin->>'checksum' ~ '^wf:v3:sha256:[0-9a-f]{64}$') IS NOT TRUE
      OR (v_pin->>'callableContractIdentity' ~ '^callable:v1:sha256:[0-9a-f]{64}$') IS NOT TRUE
      OR NOT EXISTS (SELECT 1 FROM app.workflow_versions callee
        WHERE callee.workspace_id=v_workspace AND callee.workflow_id=(v_pin->>'workflowId')::uuid
          AND callee.id=(v_pin->>'versionId')::uuid AND callee.checksum=v_pin->>'checksum'
          AND callee.schema_version=2 AND callee.executable_schema_version=3) THEN
      RAISE EXCEPTION 'native Call completion declaration differs' USING ERRCODE='55000';
    END IF;
  ELSE
    -- Same live owner as input record/read, now with all ancestor locks already
    -- acquired and receipt/current/node/attempt locks reentrant. No caller flag
    -- selects replay: only actual successful physical outcome truth does.
    v_scope:=app.lock_native_call_input_owner(p_authority);
  END IF;
  -- Independently validate the ACTUAL canonical delivery even for replay. An
  -- inbox label/checksum alone does not establish payload or completion truth.
  SELECT * INTO v_delivery FROM app.outbox_events event
    WHERE event.workspace_id=v_workspace AND event.id=v_receipt.message_id;
  IF NOT FOUND OR (v_delivery.aggregate_id=v_attempt.id
    AND v_delivery.aggregate_type='node-attempt' AND v_delivery.job_name='execute-node-attempt'
    AND v_delivery.schema_version=1 AND v_delivery.payload_checksum=v_receipt.payload_checksum
    AND v_delivery.payload->'schemaVersion'='1'::jsonb
    AND v_delivery.payload->>'workspaceId'=v_workspace::text
    AND v_delivery.payload->>'runId'=v_run.id::text
    AND v_delivery.payload->>'nodeRunId'=v_node.id::text
    AND v_delivery.payload->>'attemptId'=v_attempt.id::text
    AND v_delivery.payload->>'outboxEventId'=v_delivery.id::text
    AND v_delivery.payload-ARRAY['schemaVersion','workspaceId','runId','nodeRunId',
      'attemptId','outboxEventId','traceparent']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call completion canonical delivery differs' USING ERRCODE='55000';
  END IF;
  v_payload_text:='{"attemptId":"'||v_attempt.id::text||'","nodeRunId":"'||v_node.id::text
    ||'","outboxEventId":"'||v_delivery.id::text||'","runId":"'||v_run.id::text||'","schemaVersion":1';
  IF v_delivery.payload ? 'traceparent' THEN
    IF (v_delivery.payload->>'traceparent' ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call completion trace differs' USING ERRCODE='22023';
    END IF;
    v_payload_text:=v_payload_text||',"traceparent":"'||(v_delivery.payload->>'traceparent')||'"';
  END IF;
  v_payload_text:=v_payload_text||',"workspaceId":"'||v_workspace::text||'"}';
  IF encode(sha256(convert_to(v_payload_text,'UTF8')),'hex')<>v_delivery.payload_checksum THEN
    RAISE EXCEPTION 'native Call completion payload checksum differs' USING ERRCODE='55000';
  END IF;
  SELECT candidate.* INTO v_candidate FROM app.workflow_execution_value_artifact_candidates candidate
    JOIN app.workflow_execution_value_artifact_associations association
      ON association.workspace_id=candidate.workspace_id AND association.candidate_id=candidate.id
    WHERE candidate.workspace_id=v_workspace AND candidate.value_slot='attempt_input'
      AND candidate.attempt_id=v_attempt.id FOR SHARE OF candidate;
  SELECT * INTO v_provenance FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.value_slot='attempt_input'
      AND provenance.attempt_id=v_attempt.id FOR SHARE;
  IF NOT FOUND OR (v_provenance.workflow_run_id=v_run.id
    AND v_provenance.workflow_version_id=v_run.workflow_version_id AND v_provenance.node_run_id=v_node.id
    AND v_provenance.node_id=v_node.node_id AND v_provenance.invocation_key=v_node.invocation_key
    AND v_provenance.attempt_number=v_attempt.attempt_number AND v_provenance.byte_ownership='owned'
    AND v_provenance.eligibility_revoked_at IS NULL AND v_provenance.eligible_until>clock_timestamp()) IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call completion original input is unavailable' USING ERRCODE='55000';
  END IF;
  IF v_provenance.reference_kind='inline' THEN
    PERFORM app.assert_native_inline_execution_value_bytes(v_provenance.original_reference->'value',
      v_provenance.sha256,v_provenance.byte_length,v_provenance.original_inline_text);
  ELSE
    SELECT * INTO v_artifact FROM app.artifacts artifact
      WHERE artifact.workspace_id=v_workspace AND artifact.id=v_provenance.artifact_id FOR SHARE;
    IF NOT FOUND OR (v_candidate.id IS NOT NULL AND v_candidate.abandoned_at IS NULL
      AND v_candidate.artifact_id=v_artifact.id AND v_artifact.status='available'
      AND v_artifact.deleted_at IS NULL AND v_artifact.expires_at>clock_timestamp()
      AND v_artifact.sha256=v_provenance.sha256 AND v_artifact.byte_length=v_provenance.byte_length
      AND v_artifact.media_type=v_provenance.media_type AND v_artifact.purpose='execution-value') IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call completion original artifact is unavailable' USING ERRCODE='55000';
    END IF;
  END IF;
  IF v_replay AND v_attempt.output_ref::text IS DISTINCT FROM v_provenance.original_reference::text THEN
    RAISE EXCEPTION 'native Call completion physical output differs from first input' USING ERRCODE='23514';
  END IF;
  IF v_provenance.eligible_until<=clock_timestamp()
    OR (NOT v_replay AND ((v_scope->>'leaseExpiresAt')::timestamptz<=clock_timestamp()
      OR (v_scope->>'deadlineAt')::timestamptz<=clock_timestamp())) THEN
    RAISE EXCEPTION 'native Call completion owner expired during validation' USING ERRCODE='55000';
  END IF;
  -- Node output is deliberately NOT compared on replay: the coordinator may
  -- already have replaced that logical projection with the child's result.
  -- The deferred physical-completion clock guard below repeats the clock check
  -- in the COMMIT phase from actual OLD lease state, not a caller flag/receipt.
  RETURN v_provenance.original_reference::text;
END $$;
REVOKE ALL ON FUNCTION app.workflow_call_declaration_completion_reference(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Close the long gap between alias validation and physical writes without a
-- new receipt, lease-history owner, GUC or caller-supplied final-clock claim.
-- OLD is PostgreSQL's actual running row before completion cleared its lease.
-- Exact duplicate replay performs no physical UPDATE and cannot be mistaken for
-- fresh work. Ancestors were acquired before descendant locks by the actual
-- completion getter; this deferred check acquires NO late ancestor row locks.
CREATE FUNCTION app.check_native_call_completion_clock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_node app.node_runs%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_path uuid[]:=ARRAY[]::uuid[];
  v_current uuid;
  v_root uuid;
  v_depth integer;
  v_sites integer;
BEGIN
  SELECT * INTO v_node FROM app.node_runs node
    WHERE node.workspace_id=NEW.workspace_id AND node.id=NEW.node_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'native completion node is unavailable' USING ERRCODE='23514'; END IF;
  SELECT version.* INTO v_version FROM app.workflow_versions version
    JOIN app.workflow_runs run ON run.workspace_id=version.workspace_id
      AND run.workflow_version_id=version.id AND run.workflow_id=version.workflow_id
    WHERE run.workspace_id=NEW.workspace_id AND run.id=v_node.workflow_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native Call completion immutable version differs' USING ERRCODE='23514';
  END IF;
  IF v_version.schema_version IS DISTINCT FROM 2 OR v_version.executable_schema_version IS DISTINCT FROM 3 THEN
    RETURN NULL; -- Retained physical completion keeps its existing semantics.
  END IF;
  WITH RECURSIVE graphs(graph,depth) AS (
    SELECT v_version.executable_json->'graph',1 UNION ALL
    SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
      WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
  ) SELECT count(*)::integer INTO v_sites FROM graphs
    CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
    WHERE node->>'id'=v_node.node_id
      AND node#>>'{definition,key}'='core.workflow_call'
      AND node#>'{definition,version}'='1'::jsonb;
  -- Only actual compiled Call identity selects the declaration-input alias;
  -- ordinary native physical output uses its distinct accepted output slot.
  IF v_sites>1 THEN
    RAISE EXCEPTION 'native Call completion declaration is ambiguous' USING ERRCODE='23514';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM v_workspace OR OLD.status<>'running'
    OR NEW.status<>'succeeded' OR OLD.lease_owner IS NULL OR OLD.lease_expires_at IS NULL
    OR NOT isfinite(OLD.lease_expires_at) OR OLD.lease_expires_at<=clock_timestamp()
    OR NEW.fence_token IS DISTINCT FROM OLD.fence_token
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.node_run_id IS DISTINCT FROM OLD.node_run_id
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'native Call completion lease expired or changed before commit' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=NEW.workspace_id AND provenance.attempt_id=NEW.id
      AND provenance.node_run_id=v_node.id AND provenance.workflow_run_id=v_node.workflow_run_id
      AND provenance.node_id=v_node.node_id AND provenance.invocation_key=v_node.invocation_key
      AND provenance.attempt_number=NEW.attempt_number
      AND provenance.value_slot=CASE WHEN v_sites=1 THEN 'attempt_input' ELSE 'attempt_output' END
      AND provenance.byte_ownership='owned' AND provenance.eligibility_revoked_at IS NULL
      AND provenance.eligible_until>clock_timestamp()
      AND provenance.original_reference::text=NEW.output_ref::text) THEN
    RAISE EXCEPTION 'native completion first accepted physical bytes differ at commit' USING ERRCODE='23514';
  END IF;
  v_current:=v_node.workflow_run_id;
  PERFORM app.assert_native_call_detail_live(v_current);
  LOOP
    IF array_length(v_path,1)>=5 OR v_current=ANY(v_path) THEN
      RAISE EXCEPTION 'native Call completion commit lineage is invalid' USING ERRCODE='23514';
    END IF;
    v_path:=array_append(v_path,v_current);
    SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=v_current;
    -- The actual immediate run must still be running; a legitimate ancestor
    -- waiting for this family is live. Mutable controls cannot cross its SHARE
    -- fence; immutable deadlines must also survive this deferred clock check.
    IF NOT FOUND OR v_run.status NOT IN ('queued','running','waiting')
      OR (array_length(v_path,1)=1 AND v_run.status<>'running')
      OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at IS NULL
      OR NOT isfinite(v_run.deadline_at) OR v_run.deadline_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'native Call completion controls are active at commit' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_call FROM app.workflow_calls call
      WHERE call.workspace_id=v_workspace AND call.child_run_id=v_current
        AND call.outcome_kind='admitted' AND call.sealed;
    IF NOT FOUND THEN
      IF v_run.trigger_type='workflow_call' OR (v_root IS NOT NULL AND v_run.id<>v_root)
        OR (v_depth IS NOT NULL AND v_depth<>1) THEN
        RAISE EXCEPTION 'native Call completion commit root differs' USING ERRCODE='23514';
      END IF;
      EXIT;
    END IF;
    IF v_run.trigger_type<>'workflow_call'
      OR (v_root IS NOT NULL AND v_root<>v_call.root_run_id)
      OR (v_depth IS NOT NULL AND v_call.call_depth<>v_depth-1) THEN
      RAISE EXCEPTION 'native Call completion commit edge differs' USING ERRCODE='23514';
    END IF;
    v_root:=v_call.root_run_id;
    v_depth:=v_call.call_depth;
    v_current:=v_call.parent_run_id;
  END LOOP;
  IF OLD.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'native Call completion lease expired during commit checks' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_native_call_completion_clock()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE CONSTRAINT TRIGGER native_call_completion_clock AFTER UPDATE ON app.node_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.status='running' AND NEW.status='succeeded')
  EXECUTE FUNCTION app.check_native_call_completion_clock();

-- Protected record/read and the existing retention completion owner need access
-- Private canonical advance-job proof, shared by actual admission/result
-- commands. No receipt discovery: the existing owner supplies the exact delivery.
CREATE FUNCTION app.assert_native_advance_delivery(p_run uuid,p_event uuid,p_checksum text)
RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_event app.outbox_events%ROWTYPE; v_text text;
BEGIN
  IF v_workspace IS NULL OR p_run IS NULL OR p_event IS NULL
    OR (p_checksum ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native advance context is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_event FROM app.outbox_events event WHERE event.workspace_id=v_workspace AND event.id=p_event;
  IF NOT FOUND OR (v_event.aggregate_type='workflow-run' AND v_event.aggregate_id=p_run
    AND v_event.job_name='advance-workflow-run' AND v_event.schema_version=1
    AND v_event.payload_checksum=p_checksum AND v_event.payload->'schemaVersion'='1'::jsonb
    AND v_event.payload->>'workspaceId'=v_workspace::text AND v_event.payload->>'runId'=p_run::text
    AND v_event.payload->>'outboxEventId'=p_event::text
    AND v_event.payload-ARRAY['schemaVersion','workspaceId','runId','outboxEventId','traceparent']='{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native advance canonical payload differs' USING ERRCODE='55000';
  END IF;
  v_text:='{"outboxEventId":"'||p_event::text||'","runId":"'||p_run::text||'","schemaVersion":1';
  IF v_event.payload ? 'traceparent' THEN
    IF (v_event.payload->>'traceparent' ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
      AND substring(v_event.payload->>'traceparent',4,32)<>repeat('0',32)
      AND substring(v_event.payload->>'traceparent',37,16)<>repeat('0',16)) IS NOT TRUE THEN
      RAISE EXCEPTION 'native advance trace differs' USING ERRCODE='22023';
    END IF;
    v_text:=v_text||',"traceparent":"'||(v_event.payload->>'traceparent')||'"';
  END IF;
  v_text:=v_text||',"workspaceId":"'||v_workspace::text||'"}';
  IF encode(sha256(convert_to(v_text,'UTF8')),'hex')<>p_checksum THEN
    RAISE EXCEPTION 'native advance canonical checksum differs' USING ERRCODE='55000';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_native_advance_delivery(uuid,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Derive immutable bounded lineage; used only by the real protected owners.
-- It takes no locks so callers can acquire prerequisites before ancestor rows.
CREATE FUNCTION app.native_call_lineage(p_parent uuid) RETURNS uuid[]
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_path uuid[]:=ARRAY[p_parent]; v_current uuid:=p_parent;
  v_call app.workflow_calls%ROWTYPE; v_root uuid; v_depth integer;
BEGIN
  IF v_workspace IS NULL OR p_parent IS NULL THEN RAISE EXCEPTION 'native lineage context is invalid' USING ERRCODE='22023'; END IF;
  PERFORM app.assert_native_call_detail_live(p_parent);
  LOOP
    SELECT * INTO v_call FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
      AND call.child_run_id=v_current AND call.outcome_kind='admitted' AND call.sealed;
    IF NOT FOUND THEN
      IF (v_root IS NOT NULL AND v_current<>v_root) OR (v_depth IS NOT NULL AND v_depth<>1)
        OR NOT EXISTS(SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
          AND run.id=v_current AND run.trigger_type<>'workflow_call') THEN
        RAISE EXCEPTION 'native lineage root differs' USING ERRCODE='23514';
      END IF;
      RETURN v_path;
    END IF;
    IF array_length(v_path,1)>=5 OR v_call.parent_run_id=ANY(v_path)
      OR (v_root IS NOT NULL AND v_root<>v_call.root_run_id)
      OR (v_depth IS NOT NULL AND v_call.call_depth<>v_depth-1)
      OR NOT EXISTS(SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
        AND run.id=v_current AND run.workflow_version_id=v_call.child_workflow_version_id
        AND run.trigger_type='workflow_call') THEN
      RAISE EXCEPTION 'native lineage edge differs' USING ERRCODE='23514';
    END IF;
    v_root:=v_call.root_run_id; v_depth:=v_call.call_depth;
    v_current:=v_call.parent_run_id; v_path:=array_append(v_path,v_current);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.native_call_lineage(uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Result/control-only native advances need ancestor fences too, but must not
-- introduce admission policy/counter locks for work that creates no child.
-- Current own-run/checkpoint locks remain at the established CAS owner.
CREATE FUNCTION app.prelock_native_coordinator_lineage(p_run uuid,p_event uuid,p_checksum text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_path uuid[];
  v_index integer;
BEGIN
  PERFORM app.assert_native_advance_delivery(p_run,p_event,p_checksum);
  v_path:=app.native_call_lineage(p_run);
  FOR v_index IN REVERSE array_length(v_path,1)..2 LOOP
    PERFORM 1 FROM app.workflow_runs run
      WHERE run.workspace_id=v_workspace AND run.id=v_path[v_index] FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'native coordinator ancestor is unavailable' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF app.native_call_lineage(p_run) IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'native coordinator lineage changed' USING ERRCODE='23514';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.prelock_native_coordinator_lineage(uuid,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.prelock_native_coordinator_lineage(uuid,uuid,text) TO {{worker_runtime_role}};

CREATE FUNCTION app.prelock_workflow_call_parent(
  p_parent uuid,p_revision integer,p_supported jsonb,p_event uuid,p_checksum text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_path uuid[]; v_run app.workflow_runs%ROWTYPE; v_version app.workflow_versions%ROWTYPE;
  v_target uuid; v_destination record; v_index integer; v_checkpoint app.run_checkpoints%ROWTYPE;
BEGIN
  IF p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 2147483646 THEN
    RAISE EXCEPTION 'native parent revision is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app.lock_workspace_run_admission(v_workspace);
  PERFORM app.assert_native_advance_delivery(p_parent,p_event,p_checksum);
  v_path:=app.native_call_lineage(p_parent);
  SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=v_path[array_length(v_path,1)];
  IF NOT FOUND OR v_run.native_initiating_actor_id IS NULL OR v_run.native_initiating_role_revision IS NULL THEN
    RAISE EXCEPTION 'native root initiation is unavailable' USING ERRCODE='55000';
  END IF;
  -- Lock even inactive authority rows: exact recorded outcomes are settled
  -- before current-policy rejection. Fresh admission checks actual state below.
  PERFORM 1 FROM app.users WHERE id=v_run.native_initiating_actor_id FOR SHARE;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace
    AND user_id=v_run.native_initiating_actor_id FOR SHARE;
  PERFORM 1 FROM app.lock_node_compatibility_current_supported(p_supported);
  SELECT version.* INTO v_version FROM app.workflow_runs run JOIN app.workflow_versions version
    ON version.workspace_id=run.workspace_id AND version.id=run.workflow_version_id
    WHERE run.workspace_id=v_workspace AND run.id=p_parent AND version.schema_version=2
      AND version.executable_schema_version=3;
  IF NOT FOUND THEN RAISE EXCEPTION 'native parent executable is unavailable' USING ERRCODE='55000'; END IF;
  -- All immutable possible Call targets, not caller-selected candidate IDs.
  -- Stable workflow order before any run/checkpoint/counter lock. Notification
  -- locks use their existing owners; concurrency policy is NOT prelocked.
  FOR v_target IN WITH RECURSIVE graphs(graph,depth) AS (
    SELECT v_version.executable_json->'graph',1 UNION ALL
    SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
      WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
  ) SELECT DISTINCT (node#>>'{config,workflowId}')::uuid FROM graphs
    CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
    WHERE node#>>'{definition,key}'='core.workflow_call' AND node#>'{definition,version}'='1'::jsonb
    ORDER BY 1
  LOOP
    PERFORM 1 FROM app.workflows WHERE workspace_id=v_workspace AND id=v_target FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'native pinned workflow is unavailable' USING ERRCODE='55000'; END IF;
    FOR v_destination IN SELECT * FROM app.lock_workflow_failure_notification_policy(v_workspace,v_target)
    LOOP
      IF v_destination.connection_id IS NOT NULL THEN
        PERFORM 1 FROM app.lock_notification_connection(v_workspace,v_destination.connection_id);
      END IF;
    END LOOP;
  END LOOP;
  PERFORM 1 FROM app.workspace_execution_entitlements pointer
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=pointer.workspace_id
      AND version.version=pointer.current_version WHERE pointer.workspace_id=v_workspace FOR SHARE OF pointer,version;
  IF NOT FOUND THEN RAISE EXCEPTION 'native entitlement state is missing' USING ERRCODE='55000'; END IF;
  FOR v_index IN REVERSE array_length(v_path,1)..1 LOOP
    IF v_index=1 THEN
      SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=p_parent FOR NO KEY UPDATE;
    ELSE
      SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=v_path[v_index] FOR SHARE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'native lineage run is missing' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF app.native_call_lineage(p_parent) IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'native lineage changed during prelock' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints WHERE workspace_id=v_workspace AND workflow_run_id=p_parent FOR NO KEY UPDATE;
  IF NOT FOUND OR v_checkpoint.workflow_version_id<>v_run.workflow_version_id
    OR v_checkpoint.scheduler_state->'schemaVersion' IS DISTINCT FROM '3'::jsonb THEN
    RAISE EXCEPTION 'native parent checkpoint is unavailable' USING ERRCODE='55000';
  END IF;
  -- A revision race is classified by the EXISTING full-plan CAS owner, not by
  -- this prerequisite pass. Its rollback discards these locks without children.
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=v_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native admission counter is missing' USING ERRCODE='55000'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.prelock_workflow_call_parent(uuid,integer,jsonb,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE FUNCTION app.native_call_admission_scope(
  p_parent uuid,p_revision integer,p_invocation text,p_event uuid,p_checksum text
) RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE; v_checkpoint app.run_checkpoints%ROWTYPE;
  v_node app.node_runs%ROWTYPE; v_attempt app.node_attempts%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE; v_callee app.workflow_versions%ROWTYPE;
  v_input app.workflow_execution_value_provenance%ROWTYPE;
  v_path uuid[]; v_index integer; v_deadline timestamptz; v_stop text; v_pin jsonb; v_sites integer;
BEGIN
  IF p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 2147483646
    OR p_invocation IS NULL OR octet_length(p_invocation) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'native Call admission context is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app.assert_native_advance_delivery(p_parent,p_event,p_checksum);
  -- Exact receipt claimed by the actual coordinator, not any pending receipt
  -- for this parent. Do not discover transport authority by run ID alone.
  IF NOT EXISTS(SELECT 1 FROM app.inbox_receipts receipt WHERE receipt.workspace_id=v_workspace
    AND receipt.consumer_name='workflow-coordinator' AND receipt.message_id=p_event
    AND receipt.payload_checksum=p_checksum AND receipt.completed_at IS NULL) THEN
    RAISE EXCEPTION 'native Call admission current receipt is unavailable' USING ERRCODE='55000';
  END IF;
  v_path:=app.native_call_lineage(p_parent);
  IF array_length(v_path,1)>4 THEN
    RAISE EXCEPTION 'native Call family depth is exceeded' USING ERRCODE='23514';
  END IF;
  FOR v_index IN REVERSE array_length(v_path,1)..1 LOOP
    -- No new ancestor locks here: actual prelock acquired them BEFORE the
    -- immediate parent/counter. Read and revalidate those held immutable edges.
    SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=v_path[v_index];
    IF NOT FOUND OR v_run.status NOT IN ('running','waiting') OR v_run.deadline_at IS NULL
      OR NOT isfinite(v_run.deadline_at) THEN
      RAISE EXCEPTION 'native Call admission lineage controls are malformed' USING ERRCODE='23514';
    END IF;
    v_deadline:=least(v_deadline,v_run.deadline_at);
    IF v_run.cancel_requested_at IS NOT NULL THEN v_stop:='cancel_requested';
    ELSIF v_run.deadline_at<=clock_timestamp() AND v_stop IS NULL THEN v_stop:='deadline_expired'; END IF;
  END LOOP;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints WHERE workspace_id=v_workspace
    AND workflow_run_id=p_parent;
  IF NOT FOUND OR v_checkpoint.revision<>p_revision OR v_checkpoint.workflow_version_id<>v_run.workflow_version_id
    OR v_checkpoint.scheduler_state->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR v_checkpoint.scheduler_state->'revision' IS DISTINCT FROM to_jsonb(p_revision) THEN
    RAISE EXCEPTION 'native Call admission revision differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_node FROM app.node_runs node WHERE node.workspace_id=v_workspace
    AND node.workflow_run_id=p_parent AND node.invocation_key=p_invocation FOR SHARE;
  IF NOT FOUND OR v_node.current_attempt_id IS NULL OR v_node.current_attempt_number<>1
    OR v_node.side_effect_class<>'unsafe' OR v_node.status NOT IN ('succeeded','waiting') THEN
    RAISE EXCEPTION 'native Call declaration is unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_attempt FROM app.node_attempts attempt WHERE attempt.workspace_id=v_workspace
    AND attempt.node_run_id=v_node.id AND attempt.id=v_node.current_attempt_id FOR SHARE;
  IF NOT FOUND OR v_attempt.status<>'succeeded' OR v_attempt.attempt_number<>1
    OR v_attempt.side_effect_class<>'unsafe' OR v_attempt.completed_at IS NULL
    OR v_attempt.lease_owner IS NOT NULL OR v_attempt.lease_expires_at IS NOT NULL
    OR v_attempt.safe_error_code IS NOT NULL OR v_attempt.error_summary IS NOT NULL
    OR v_attempt.executor_failure_kind IS NOT NULL OR v_attempt.executor_error_kind IS NOT NULL
    OR v_attempt.executor_possibly_dispatched IS NOT NULL OR v_attempt.retry_decision IS NOT NULL THEN
    RAISE EXCEPTION 'native Call physical declaration differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_version FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.id=v_run.workflow_version_id AND version.workflow_id=v_run.workflow_id;
  IF NOT FOUND OR v_version.schema_version<>2 OR v_version.executable_schema_version<>3 THEN
    RAISE EXCEPTION 'native Call parent version differs' USING ERRCODE='23514';
  END IF;
  WITH RECURSIVE graphs(graph,depth) AS (
    SELECT v_version.executable_json->'graph',1 UNION ALL
    SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
      CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
      WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
  ), sites AS (SELECT node FROM graphs CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
    WHERE node->>'id'=v_node.node_id AND node#>>'{definition,key}'='core.workflow_call'
      AND node#>'{definition,version}'='1'::jsonb)
  SELECT count(*)::integer,(jsonb_agg(node->'config'))->0 INTO v_sites,v_pin FROM sites;
  IF v_sites<>1 OR (v_pin ?& ARRAY['workflowId','versionId','checksum','callableContractIdentity']
    AND v_pin-ARRAY['workflowId','versionId','checksum','callableContractIdentity']='{}'::jsonb
    AND v_pin->>'checksum' ~ '^wf:v3:sha256:[0-9a-f]{64}$'
    AND v_pin->>'callableContractIdentity' ~ '^callable:v1:sha256:[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call immutable site differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_callee FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.workflow_id=(v_pin->>'workflowId')::uuid AND version.id=(v_pin->>'versionId')::uuid
    AND version.checksum=v_pin->>'checksum' AND version.schema_version=2 AND version.executable_schema_version=3;
  IF NOT FOUND THEN RAISE EXCEPTION 'native Call pinned callee is missing' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_input FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.attempt_id=v_attempt.id
      AND provenance.value_slot='attempt_input' FOR SHARE;
  IF NOT FOUND OR (v_input.workflow_run_id=p_parent AND v_input.workflow_version_id=v_run.workflow_version_id
    AND v_input.node_run_id=v_node.id AND v_input.node_id=v_node.node_id
    AND v_input.invocation_key=p_invocation AND v_input.attempt_number=1 AND v_input.byte_ownership='owned'
    AND v_input.eligibility_revoked_at IS NULL AND v_input.eligible_until>clock_timestamp()
    AND v_input.original_reference::text=v_attempt.output_ref::text
    AND v_input.original_reference::text=v_node.input_ref::text) IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call first declaration input differs' USING ERRCODE='23514';
  END IF;
  IF v_input.reference_kind='inline' THEN
    PERFORM app.assert_native_inline_execution_value_bytes(v_input.original_reference->'value',
      v_input.sha256,v_input.byte_length,v_input.original_inline_text);
    -- Validate the FIRST accepted value against the actual immutable callee,
    -- not the caller's declaration or an input-reference-shaped payload.
    PERFORM app.assert_native_callable_value(v_callee.executable_json#>'{graph,callable,input}',
      v_input.original_reference->'value');
  ELSE
    -- The minimum path is inline. Unsupported artifact admission is operational,
    -- never a definite refusal or reinterpretation of the accepted producer.
    RAISE EXCEPTION 'native Call artifact admission is unavailable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.run_events event WHERE event.workspace_id=v_workspace
    AND event.workflow_run_id=p_parent AND event.type='node.succeeded'
    AND event.payload->>'attemptId'=v_attempt.id::text AND event.payload->>'nodeRunId'=v_node.id::text
    AND event.payload->>'invocationKey'=p_invocation AND event.payload->>'nodeId'=v_node.node_id
    AND event.payload->'attemptNumber'='1'::jsonb) THEN
    RAISE EXCEPTION 'native Call physical completion fact is missing' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('workspaceId',v_workspace,'parentRunId',p_parent,
    'parentVersionId',v_run.workflow_version_id,'rootRunId',v_path[array_length(v_path,1)],
    'depth',array_length(v_path,1),'deadlineAt',v_deadline,'stop',v_stop,'pin',v_pin,
    'engineVersion',v_checkpoint.engine_version,'nodeRunId',v_node.id,'nodeId',v_node.node_id,
    'invocationKey',p_invocation,'attemptId',v_attempt.id,'attemptNumber',v_attempt.attempt_number,
    'inputId',v_input.id,'inputRef',v_input.original_reference,'inputRefJson',v_input.original_reference::text,
    'inputChecksum',v_input.sha256,'inputEligibleUntil',v_input.eligible_until);
END $$;
REVOKE ALL ON FUNCTION app.native_call_admission_scope(uuid,integer,text,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE FUNCTION app.lock_workflow_call_admission(
  p_parent uuid,p_revision integer,p_invocation text,p_candidate uuid,p_event uuid,p_checksum text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.native_call_admission_scope(p_parent,p_revision,p_invocation,p_event,p_checksum);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_call app.workflow_calls%ROWTYPE; v_root app.workflow_runs%ROWTYPE;
  v_child app.workflow_runs%ROWTYPE; v_entitlement record; v_common jsonb;
  v_region app.regional_write_admission%ROWTYPE; v_refusal text;
BEGIN
  IF p_candidate IS NULL OR EXISTS(SELECT 1 FROM app.workflow_runs WHERE id=p_candidate) THEN
    RAISE EXCEPTION 'native Call candidate identity is not fresh' USING ERRCODE='23514';
  END IF;
  v_common:=jsonb_build_object('pin',v_scope->'pin','engineVersion',v_scope->>'engineVersion');
  SELECT * INTO v_call FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
    AND call.parent_run_id=p_parent AND call.invocation_key=p_invocation FOR UPDATE;
  IF FOUND THEN
    IF NOT v_call.sealed OR v_call.declaration_input_provenance_id<>(v_scope->>'inputId')::uuid
      OR v_call.declaration_attempt_id<>(v_scope->>'attemptId')::uuid
      OR v_call.callee_workflow_version_id<>(v_scope#>>'{pin,versionId}')::uuid THEN
      RAISE EXCEPTION 'native Call recorded identity differs' USING ERRCODE='23514';
    END IF;
    IF v_call.outcome_kind='admitted' THEN
      SELECT * INTO v_child FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=v_call.child_run_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'native Call recorded child is missing' USING ERRCODE='23514'; END IF;
      RETURN v_common||jsonb_build_object('kind','recorded','accepted',jsonb_build_object(
        'acceptedAt',v_child.created_at,'outboxEventId',v_call.child_outbox_event_id,'runId',v_child.id,'status',v_child.status));
    ELSIF v_call.outcome_kind='refused' THEN
      RETURN v_common||jsonb_build_object('kind','refused','reasonCode',v_call.refusal_code);
    ELSE RETURN v_common||jsonb_build_object('kind','stopped','reason',v_call.abort_reason); END IF;
  END IF;
  IF v_scope->>'stop' IS NOT NULL THEN RETURN v_common||jsonb_build_object('kind','stopped','reason',v_scope->>'stop'); END IF;
  SELECT * INTO v_root FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=(v_scope->>'rootRunId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM app.users user_row JOIN app.workspace_memberships membership
    ON membership.user_id=user_row.id AND membership.workspace_id=v_workspace
    WHERE user_row.id=v_root.native_initiating_actor_id AND user_row.status='active'
      AND membership.status='active' AND membership.role IN ('owner','admin','builder','operator')
      AND membership.role_revision=v_root.native_initiating_role_revision) THEN
    v_refusal:='workflow.child_authority_unavailable';
  ELSIF NOT EXISTS(SELECT 1 FROM app.workspaces WHERE id=v_workspace AND status='active')
    OR NOT EXISTS(SELECT 1 FROM app.workflows WHERE workspace_id=v_workspace
      AND id=(v_scope#>>'{pin,workflowId}')::uuid AND lifecycle_status='active') THEN
    v_refusal:='workflow.child_admission_unavailable';
  END IF;
  SELECT * INTO v_region FROM app.regional_write_admission WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'native regional admission state is missing' USING ERRCODE='55000'; END IF;
  IF v_region.enforced AND (v_region.status<>'open' OR v_region.observed_at IS NULL
    OR v_region.observed_at<now()-interval '15 seconds') THEN v_refusal:=coalesce(v_refusal,'workflow.child_admission_unavailable'); END IF;
  SELECT version.* INTO v_entitlement FROM app.workspace_execution_entitlements pointer
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=pointer.workspace_id
      AND version.version=pointer.current_version WHERE pointer.workspace_id=v_workspace;
  IF NOT FOUND THEN RAISE EXCEPTION 'native entitlement state is missing' USING ERRCODE='55000'; END IF;
  IF v_entitlement.status<>'active' OR v_entitlement.effective_at>clock_timestamp()
    OR v_entitlement.expires_at<=clock_timestamp() THEN v_refusal:=coalesce(v_refusal,'workflow.child_entitlement_unavailable'); END IF;
  IF v_refusal IS NULL AND (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=v_workspace AND status='queued')
    >=v_entitlement.queued_run_limit THEN v_refusal:='workflow.child_queue_unavailable'; END IF;
  IF (SELECT count(*) FROM app.workflow_calls WHERE workspace_id=v_workspace
    AND root_run_id=v_root.id AND outcome_kind='admitted')>=64 THEN
    RAISE EXCEPTION 'native Call family child bound is exceeded' USING ERRCODE='23514';
  END IF;
  IF v_refusal IS NOT NULL THEN RETURN v_common||jsonb_build_object('kind','refused','reasonCode',v_refusal); END IF;
  IF (v_scope->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    RETURN v_common||jsonb_build_object('kind','stopped','reason','deadline_expired');
  END IF;
  RETURN v_common||jsonb_build_object('kind','allowed','inputRef',v_scope->'inputRef',
    'inputRefJson',v_scope->>'inputRefJson','inputChecksum',v_scope->>'inputChecksum',
    'deadlineAt',v_scope->>'deadlineAt');
END $$;
REVOKE ALL ON FUNCTION app.lock_workflow_call_admission(uuid,integer,text,uuid,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Focused extraction within the EXISTING concurrency/admission owner. Both
-- retained row-backed grants and rolled-back NEXT-ticket checks use this one
-- predicate. NULL run means the next new ordinary ticket, never a slot exemption.
CREATE FUNCTION app.workflow_concurrency_candidate_admissible(
  p_workspace uuid,p_workflow uuid,p_run uuid,p_grant boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_limit integer; v_ticket bigint; v_reserved boolean; v_exempt boolean;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_run IS NULL AND p_grant IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'new admission check requires grant semantics' USING ERRCODE='22023';
  END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=p_workflow;
  IF v_limit IS NULL THEN RETURN true; END IF;
  IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    IF p_grant THEN RETURN false; END IF;
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  IF p_run IS NOT NULL THEN
    SELECT admission_ticket INTO v_ticket FROM app.workflow_runs WHERE workspace_id=p_workspace
      AND id=p_run AND workflow_id=p_workflow;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
      FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
    IF v_reserved AND (p_grant OR v_exempt) THEN RETURN true; END IF;
  END IF;
  IF NOT coalesce(v_reserved,false) AND
    (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=p_workspace
      AND workflow_id=p_workflow AND status IN ('running','waiting'))+
    (SELECT count(*) FROM app.workflow_run_active_admissions admission JOIN app.workflow_runs run
      ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
      WHERE admission.workspace_id=p_workspace AND run.workflow_id=p_workflow)>=v_limit THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM app.workflow_runs earlier WHERE earlier.workspace_id=p_workspace
    AND earlier.workflow_id=p_workflow AND earlier.status='queued'
    AND (p_run IS NULL OR earlier.admission_ticket<v_ticket)
    AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission WHERE admission.workspace_id=p_workspace
      AND admission.workflow_run_id=earlier.id AND (p_grant OR admission.workflow_concurrency_order_exempt)));
END $$;
REVOKE ALL ON FUNCTION app.workflow_concurrency_candidate_admissible(uuid,uuid,uuid,boolean)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE OR REPLACE FUNCTION app.workflow_concurrency_admissible(p_workspace uuid,p_run uuid,p_grant boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_run app.workflow_runs%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_run.status<>'queued' THEN RETURN true; END IF;
  RETURN app.workflow_concurrency_candidate_admissible(p_workspace,v_run.workflow_id,p_run,p_grant);
END $$;

CREATE FUNCTION app.workflow_run_new_active_admission_eligible(
  p_workspace uuid,p_workflow uuid,p_run uuid,p_entitlement integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_limit integer; v_status text;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace;
  SELECT active_run_limit INTO v_limit FROM app.workspace_execution_entitlement_versions
    WHERE workspace_id=p_workspace AND version=p_entitlement;
  RETURN coalesce(v_status='active'
    AND app.workflow_concurrency_candidate_admissible(p_workspace,p_workflow,p_run,true)
    AND (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=p_workspace AND status IN ('running','waiting'))+
      (SELECT count(*) FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace)<v_limit,false);
END $$;
REVOKE ALL ON FUNCTION app.workflow_run_new_active_admission_eligible(uuid,uuid,uuid,integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE OR REPLACE FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid,p_outbox_event_id uuid,p_workflow_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_result boolean:=false;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSIF EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id
      AND workflow_run_id=p_workflow_run_id AND outbox_event_id=p_outbox_event_id) THEN
      -- Preserve existing workspace and concurrency gates for a recorded grant.
      v_result:=EXISTS(SELECT 1 FROM app.workspaces WHERE id=p_workspace_id AND status='active')
        AND app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true);
    ELSIF NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id
      AND workflow_run_id=p_workflow_run_id) THEN
      v_result:=app.workflow_run_new_active_admission_eligible(p_workspace_id,v_run.workflow_id,p_workflow_run_id,v_run.execution_entitlement_version);
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN coalesce(v_result,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE FUNCTION app.reserve_workflow_call_active_admission(
  p_parent uuid,p_revision integer,p_invocation text,p_candidate uuid,p_child_event uuid,p_event uuid,p_checksum text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.native_call_admission_scope(p_parent,p_revision,p_invocation,p_event,p_checksum);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_child app.workflow_runs%ROWTYPE; v_event app.outbox_events%ROWTYPE;
BEGIN
  IF v_scope->>'stop' IS NOT NULL OR (v_scope->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    -- Not capacity. Whole speculative transaction rolls back/reloads controls.
    RAISE EXCEPTION 'native Call control changed before reservation' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_child FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=p_candidate;
  IF NOT FOUND OR (v_child.workflow_id=(v_scope#>>'{pin,workflowId}')::uuid
    AND v_child.workflow_version_id=(v_scope#>>'{pin,versionId}')::uuid AND v_child.trigger_type='workflow_call'
    AND v_child.status='queued' AND v_child.cancel_requested_at IS NULL
    AND v_child.deadline_at IS NOT NULL AND isfinite(v_child.deadline_at)
    AND v_child.deadline_at<=(v_scope->>'deadlineAt')::timestamptz AND v_child.deadline_at>clock_timestamp()
    AND v_child.input_ref::text=v_scope->>'inputRefJson') IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call candidate insertion differs' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.idempotency_records claim WHERE claim.workspace_id=v_workspace
    AND claim.operation='workflow.run.accept' AND claim.scope='workflow-call:'||p_parent::text
    AND claim.key_hash=encode(sha256(convert_to(p_invocation,'UTF8')),'hex')
    AND claim.resource_id=p_candidate AND claim.status='in_progress') THEN
    RAISE EXCEPTION 'native Call candidate canonical claim is missing' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.run_checkpoints checkpoint WHERE checkpoint.workspace_id=v_workspace
    AND checkpoint.workflow_run_id=p_candidate AND checkpoint.workflow_version_id=v_child.workflow_version_id
    AND checkpoint.revision=0 AND checkpoint.engine_version=v_scope->>'engineVersion'
    AND checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND checkpoint.scheduler_state->'revision'='0'::jsonb
    AND checkpoint.scheduler_state->>'runStatus'='queued'
    AND checkpoint.scheduler_state->'calls'='[]'::jsonb) THEN
    RAISE EXCEPTION 'native Call initial checkpoint is missing' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_event FROM app.outbox_events WHERE workspace_id=v_workspace AND id=p_child_event;
  IF NOT FOUND THEN RAISE EXCEPTION 'native Call initial delivery is missing' USING ERRCODE='23514'; END IF;
  PERFORM app.assert_native_advance_delivery(p_candidate,p_child_event,v_event.payload_checksum);
  -- Workspace FK and our new candidate are already owned before the counter:
  -- the existing dispatcher's SKIP LOCKED cannot turn an unrelated lock failure
  -- into a capacity refusal here. Keep its single FIFO/capacity implementation.
  IF NOT app.reserve_workflow_run_active_admission(v_workspace,p_child_event,p_candidate) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
    WHERE admission.workspace_id=v_workspace AND admission.workflow_run_id=p_candidate
      AND admission.outbox_event_id=p_child_event) THEN
    RAISE EXCEPTION 'native Call independent reservation is missing' USING ERRCODE='23514';
  END IF;
  IF (v_scope->>'deadlineAt')::timestamptz<=clock_timestamp() OR v_child.deadline_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'native Call deadline expired during reservation' USING ERRCODE='55000';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.reserve_workflow_call_active_admission(uuid,integer,text,uuid,uuid,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE FUNCTION app.record_workflow_call_outcome(
  p_parent uuid,p_revision integer,p_invocation text,p_outcome jsonb,p_event uuid,p_checksum text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.native_call_admission_scope(p_parent,p_revision,p_invocation,p_event,p_checksum);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid; v_kind text:=p_outcome->>'kind';
  v_call app.workflow_calls%ROWTYPE; v_child app.workflow_runs%ROWTYPE;
  v_child_event app.outbox_events%ROWTYPE; v_proof jsonb;
BEGIN
  IF (jsonb_typeof(p_outcome)='object' AND (
    (v_kind='admitted' AND p_outcome ?& ARRAY['childRunId','outboxEventId']
      AND p_outcome-ARRAY['kind','childRunId','outboxEventId']='{}'::jsonb) OR
    (v_kind='refused' AND p_outcome ? 'reasonCode' AND p_outcome-ARRAY['kind','reasonCode']='{}'::jsonb) OR
    (v_kind='aborted' AND p_outcome ? 'reason' AND p_outcome-ARRAY['kind','reason']='{}'::jsonb)
  )) IS NOT TRUE THEN RAISE EXCEPTION 'native Call outcome shape differs' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=v_workspace
    AND parent_run_id=p_parent AND invocation_key=p_invocation FOR UPDATE;
  IF FOUND THEN
    IF v_call.outcome_kind IS DISTINCT FROM v_kind
      OR v_call.declaration_input_provenance_id<>(v_scope->>'inputId')::uuid
      OR (v_kind='admitted' AND (v_call.child_run_id IS DISTINCT FROM (p_outcome->>'childRunId')::uuid
        OR v_call.child_outbox_event_id IS DISTINCT FROM (p_outcome->>'outboxEventId')::uuid))
      OR (v_kind='refused' AND v_call.refusal_code IS DISTINCT FROM p_outcome->>'reasonCode')
      OR (v_kind='aborted' AND v_call.abort_reason IS DISTINCT FROM p_outcome->>'reason') THEN
      RAISE EXCEPTION 'native Call immutable outcome differs' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF v_kind='admitted' THEN
    SELECT * INTO v_child FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=(p_outcome->>'childRunId')::uuid;
    IF NOT FOUND OR v_scope->>'stop' IS NOT NULL OR (v_child.trigger_type='workflow_call'
      AND v_child.workflow_id=(v_scope#>>'{pin,workflowId}')::uuid
      AND v_child.workflow_version_id=(v_scope#>>'{pin,versionId}')::uuid AND v_child.status='queued'
      AND v_child.input_ref::text=v_scope->>'inputRefJson'
      AND v_child.deadline_at<=(v_scope->>'deadlineAt')::timestamptz
      AND v_child.deadline_at>clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call accepted candidate differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_child_event FROM app.outbox_events WHERE workspace_id=v_workspace AND id=(p_outcome->>'outboxEventId')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'native Call accepted child delivery is missing' USING ERRCODE='23514'; END IF;
    PERFORM app.assert_native_advance_delivery(v_child.id,v_child_event.id,v_child_event.payload_checksum);
    IF NOT EXISTS(SELECT 1 FROM app.idempotency_records claim WHERE claim.workspace_id=v_workspace
      AND claim.operation='workflow.run.accept' AND claim.scope='workflow-call:'||p_parent::text
      AND claim.key_hash=encode(sha256(convert_to(p_invocation,'UTF8')),'hex') AND claim.status='completed'
      AND claim.resource_id=v_child.id AND claim.result_ref->>'outboxEventId'=v_child_event.id::text
      AND claim.result_ref->>'initialCheckpointHash' ~ '^[0-9a-f]{64}$')
      OR NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission WHERE admission.workspace_id=v_workspace
        AND admission.workflow_run_id=v_child.id AND admission.outbox_event_id=v_child_event.id) THEN
      RAISE EXCEPTION 'native Call accepted claim/reservation differs' USING ERRCODE='23514';
    END IF;
  ELSIF v_kind='aborted' THEN
    IF p_outcome->>'reason' IS DISTINCT FROM v_scope->>'stop' OR v_scope->>'stop' IS NULL THEN
      RAISE EXCEPTION 'native Call abort control is not authoritative' USING ERRCODE='23514';
    END IF;
  ELSE
    -- Recompute locked policy truth AFTER the candidate savepoint rollback.
    -- A boolean/caller SQLSTATE never becomes refusal authority. This uses no
    -- candidate row/receipt and allocates no claim or child.
    v_proof:=app.lock_workflow_call_admission(p_parent,p_revision,p_invocation,gen_random_uuid(),p_event,p_checksum);
    IF p_outcome->>'reasonCode'='workflow.child_capacity_unavailable' THEN
      IF v_proof->>'kind' IS DISTINCT FROM 'allowed' OR app.workflow_run_new_active_admission_eligible(
        v_workspace,(v_scope#>>'{pin,workflowId}')::uuid,NULL,
        (SELECT current_version FROM app.workspace_execution_entitlements WHERE workspace_id=v_workspace)) THEN
        RAISE EXCEPTION 'native Call capacity refusal is not authoritative' USING ERRCODE='23514';
      END IF;
    ELSIF v_proof->>'kind' IS DISTINCT FROM 'refused' OR v_proof->>'reasonCode' IS DISTINCT FROM p_outcome->>'reasonCode' THEN
      RAISE EXCEPTION 'native Call refusal is not authoritative' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO app.workflow_calls(id,workspace_id,parent_run_id,parent_workflow_version_id,root_run_id,
    node_run_id,node_id,invocation_key,declaration_attempt_id,declaration_attempt_number,
    declaration_input_provenance_id,callee_workflow_id,callee_workflow_version_id,call_depth,
    inherited_deadline_at,expected_parent_revision,parent_delivery_outbox_event_id,parent_delivery_payload_checksum,
    outcome_kind,child_run_id,child_workflow_version_id,child_outbox_event_id,child_outbox_payload_checksum,refusal_code,abort_reason)
  VALUES(gen_random_uuid(),v_workspace,p_parent,(v_scope->>'parentVersionId')::uuid,(v_scope->>'rootRunId')::uuid,
    (v_scope->>'nodeRunId')::uuid,v_scope->>'nodeId',p_invocation,(v_scope->>'attemptId')::uuid,1,
    (v_scope->>'inputId')::uuid,(v_scope#>>'{pin,workflowId}')::uuid,(v_scope#>>'{pin,versionId}')::uuid,
    (v_scope->>'depth')::integer,(v_scope->>'deadlineAt')::timestamptz,p_revision,p_event,p_checksum,
    v_kind,v_child.id,v_child.workflow_version_id,v_child_event.id,v_child_event.payload_checksum,
    CASE WHEN v_kind='refused' THEN p_outcome->>'reasonCode' END,
    CASE WHEN v_kind='aborted' THEN p_outcome->>'reason' END);
END $$;
REVOKE ALL ON FUNCTION app.record_workflow_call_outcome(uuid,integer,text,jsonb,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE FUNCTION app.seal_workflow_call_parent(
  p_parent uuid,p_revision integer,p_continuation uuid,p_event uuid,p_checksum text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_parent app.workflow_runs%ROWTYPE; v_checkpoint app.run_checkpoints%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE; v_child app.workflow_runs%ROWTYPE;
  v_source app.workflow_execution_value_provenance%ROWTYPE; v_borrow app.workflow_execution_value_provenance%ROWTYPE;
  v_node app.node_runs%ROWTYPE; v_attempt app.node_attempts%ROWTYPE;
  v_declaration jsonb; v_invocation jsonb; v_count integer; v_continuation app.outbox_events%ROWTYPE;
BEGIN
  IF p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 2147483646 THEN
    RAISE EXCEPTION 'native Call seal revision is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app.assert_native_advance_delivery(p_parent,p_event,p_checksum);
  IF NOT EXISTS(SELECT 1 FROM app.inbox_receipts WHERE workspace_id=v_workspace
    AND consumer_name='workflow-coordinator' AND message_id=p_event AND payload_checksum=p_checksum
    AND completed_at IS NULL) THEN RAISE EXCEPTION 'native Call seal current receipt differs' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_parent FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=p_parent;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints WHERE workspace_id=v_workspace AND workflow_run_id=p_parent;
  IF NOT FOUND OR (v_checkpoint.revision=p_revision+1 AND v_checkpoint.workflow_version_id=v_parent.workflow_version_id
    AND v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND v_checkpoint.scheduler_state->'revision'=to_jsonb(p_revision+1)
    AND v_checkpoint.scheduler_state->>'workflowVersionId'=v_parent.workflow_version_id::text
    AND v_checkpoint.scheduler_state->>'runStatus'=v_parent.status
    AND v_checkpoint.scheduler_state->>'engineVersion'=v_checkpoint.engine_version
    AND v_checkpoint.last_transition_fingerprint ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call seal actual post-CAS state differs' USING ERRCODE='23514';
  END IF;
  -- Full-plan equality/recovery remains at the EXISTING checkpoint CAS owner.
  -- The fingerprint's presence here is NOT authorization. Independently bind
  -- actual post-CAS Call declarations/invocations and physical/child truth below.
  -- No copy of that full fingerprint is stored in journal/provenance/candidate.
  IF p_continuation IS NOT NULL THEN
    SELECT * INTO v_continuation FROM app.outbox_events WHERE workspace_id=v_workspace AND id=p_continuation;
    IF NOT FOUND OR p_continuation=p_event OR v_continuation.published_at IS NOT NULL
      OR v_continuation.failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'native Call continuation differs' USING ERRCODE='23514';
    END IF;
    PERFORM app.assert_native_advance_delivery(p_parent,p_continuation,v_continuation.payload_checksum);
  END IF;
  FOR v_call IN SELECT * FROM app.workflow_calls WHERE workspace_id=v_workspace AND parent_run_id=p_parent
    AND expected_parent_revision=p_revision AND parent_delivery_outbox_event_id=p_event
    AND parent_delivery_payload_checksum=p_checksum ORDER BY invocation_key FOR UPDATE
  LOOP
    IF v_call.detail_retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'native Call seal detail is retired' USING ERRCODE='55000';
    END IF;
    SELECT count(*)::integer,(jsonb_agg(entry))->0 INTO v_count,v_declaration
      FROM jsonb_array_elements(v_checkpoint.scheduler_state->'calls') entry WHERE entry->>'invocationKey'=v_call.invocation_key;
    IF v_count<>1 OR (v_declaration->>'nodeId'=v_call.node_id
      AND v_declaration->>'declarationAttemptId'=v_call.declaration_attempt_id::text
      AND v_declaration#>>'{pin,workflowId}'=v_call.callee_workflow_id::text
      AND v_declaration#>>'{pin,versionId}'=v_call.callee_workflow_version_id::text
      AND v_declaration->>'status'='awaiting_admission') IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call post-CAS declaration differs' USING ERRCODE='23514';
    END IF;
    SELECT count(*)::integer,(jsonb_agg(entry))->0 INTO v_count,v_invocation
      FROM jsonb_array_elements(v_checkpoint.scheduler_state->'invocations') entry WHERE entry->>'invocationKey'=v_call.invocation_key;
    IF v_count<>1 OR v_invocation->>'nodeId' IS DISTINCT FROM v_call.node_id
      OR v_invocation->>'status' IS DISTINCT FROM 'waiting' THEN
      RAISE EXCEPTION 'native Call post-CAS invocation differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_source FROM app.workflow_execution_value_provenance WHERE workspace_id=v_workspace
      AND id=v_call.declaration_input_provenance_id FOR SHARE;
    IF NOT FOUND OR v_source.eligibility_revoked_at IS NOT NULL OR v_source.eligible_until<=clock_timestamp()
      OR v_source.sha256 IS DISTINCT FROM v_declaration->>'inputChecksum'
      OR (v_source.reference_kind='inline' AND (v_declaration->'input' IS DISTINCT FROM
        jsonb_build_object('kind','inline','attemptId',v_call.declaration_attempt_id))) THEN
      RAISE EXCEPTION 'native Call post-CAS input identity differs' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
      AND version.id=v_call.callee_workflow_version_id AND version.workflow_id=v_call.callee_workflow_id
      AND version.checksum=v_declaration#>>'{pin,checksum}') THEN
      RAISE EXCEPTION 'native Call post-CAS immutable pin differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_node FROM app.node_runs WHERE workspace_id=v_workspace AND id=v_call.node_run_id;
    SELECT * INTO v_attempt FROM app.node_attempts WHERE workspace_id=v_workspace AND id=v_call.declaration_attempt_id;
    IF NOT FOUND OR (v_node.workflow_run_id=p_parent AND v_node.node_id=v_call.node_id
      AND v_node.invocation_key=v_call.invocation_key AND v_node.current_attempt_id=v_attempt.id
      AND v_node.status='waiting' AND v_node.control_kind='workflow_call'
      AND v_attempt.node_run_id=v_node.id AND v_attempt.attempt_number=v_call.declaration_attempt_number
      AND v_attempt.status='succeeded' AND v_attempt.output_ref::text=v_source.original_reference::text
      AND v_node.input_ref::text=v_source.original_reference::text) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call post-CAS physical/logical state differs' USING ERRCODE='23514';
    END IF;
    IF v_call.outcome_kind<>'admitted' AND p_continuation IS NULL THEN
      RAISE EXCEPTION 'native Call definite non-child outcome requires continuation' USING ERRCODE='23514';
    END IF;
    IF NOT v_call.sealed THEN
      UPDATE app.workflow_calls SET sealed=true,sealed_parent_revision=p_revision+1
        WHERE workspace_id=v_workspace AND id=v_call.id;
    ELSIF v_call.sealed_parent_revision<>p_revision+1 THEN
      RAISE EXCEPTION 'native Call immutable seal revision differs' USING ERRCODE='23514';
    END IF;
    IF v_call.outcome_kind='admitted' THEN
      -- The canonical child is NEW in this transaction; do not take a child
      -- UPDATE behind the held counter. Exact recorded recovery never reseals.
      SELECT * INTO v_child FROM app.workflow_runs WHERE workspace_id=v_workspace AND id=v_call.child_run_id;
      IF NOT FOUND OR (v_child.workflow_version_id=v_call.child_workflow_version_id
        AND v_child.trigger_type='workflow_call' AND v_child.status='queued'
        AND v_child.deadline_at<=v_call.inherited_deadline_at AND v_child.deadline_at>clock_timestamp()
        AND v_child.input_ref::text=v_source.original_reference::text
        AND EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=v_workspace
          AND workflow_run_id=v_child.id AND outbox_event_id=v_call.child_outbox_event_id)) IS NOT TRUE THEN
        RAISE EXCEPTION 'native Call seal accepted child differs' USING ERRCODE='23514';
      END IF;
      SELECT * INTO v_borrow FROM app.workflow_execution_value_provenance WHERE workspace_id=v_workspace
        AND workflow_run_id=v_child.id AND value_slot='run_input';
      IF FOUND THEN
        IF v_borrow.byte_ownership<>'borrowed' OR v_borrow.borrowed_from_provenance_id<>v_source.id
          OR v_borrow.borrowed_workflow_call_id<>v_call.id OR v_borrow.workflow_version_id<>v_child.workflow_version_id THEN
          RAISE EXCEPTION 'native Call immutable borrowed input differs' USING ERRCODE='23514';
        END IF;
      ELSE
        INSERT INTO app.workflow_execution_value_provenance(id,workspace_id,workflow_run_id,workflow_version_id,
          value_slot,byte_ownership,borrowed_from_provenance_id,borrowed_from_slot,borrowed_from_ownership,
          borrowed_workflow_call_id,borrowed_call_outcome,borrowed_call_sealed,accepted_at,eligible_until)
        VALUES(gen_random_uuid(),v_workspace,v_child.id,v_child.workflow_version_id,'run_input','borrowed',
          v_source.id,'attempt_input','owned',v_call.id,'admitted',true,v_child.created_at,
          least(v_source.eligible_until,v_child.input_ref_expires_at));
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.seal_workflow_call_parent(uuid,integer,uuid,uuid,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Every direct/native child insert must satisfy the same final-state obligation
-- as actual canonical acceptance. No label, borrowed UUID or receipt alone can
-- leave a ghost child, orphan reservation or unsealed admitted journal at COMMIT.
CREATE FUNCTION app.check_native_child_acceptance_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.workflow_runs WHERE workspace_id=NEW.workspace_id AND id=NEW.id) THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_calls call JOIN app.workflow_execution_value_provenance borrowed
    ON borrowed.workspace_id=call.workspace_id AND borrowed.workflow_run_id=call.child_run_id
      AND borrowed.borrowed_workflow_call_id=call.id AND borrowed.borrowed_from_provenance_id=call.declaration_input_provenance_id
    JOIN app.workflow_execution_value_provenance source ON source.workspace_id=call.workspace_id
      AND source.id=call.declaration_input_provenance_id
    JOIN app.run_checkpoints checkpoint ON checkpoint.workspace_id=NEW.workspace_id AND checkpoint.workflow_run_id=NEW.id
    JOIN app.workflow_run_active_admissions admission ON admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=NEW.id
    WHERE call.workspace_id=NEW.workspace_id AND call.child_run_id=NEW.id AND call.child_workflow_version_id=NEW.workflow_version_id
      AND call.outcome_kind='admitted' AND call.sealed AND borrowed.value_slot='run_input' AND borrowed.byte_ownership='borrowed'
      AND borrowed.borrowed_call_sealed AND borrowed.borrowed_call_outcome='admitted'
      AND borrowed.workflow_version_id=NEW.workflow_version_id AND source.byte_ownership='owned' AND source.value_slot='attempt_input'
      AND source.original_reference::text=NEW.input_ref::text AND NEW.deadline_at<=call.inherited_deadline_at
      AND checkpoint.revision=0 AND checkpoint.workflow_version_id=NEW.workflow_version_id
      AND checkpoint.scheduler_state->'schemaVersion'='3'::jsonb AND checkpoint.scheduler_state->>'runStatus'='queued'
      AND admission.outbox_event_id=call.child_outbox_event_id) THEN
    RAISE EXCEPTION 'native child canonical acceptance is incomplete at commit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_native_child_acceptance_commit()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE CONSTRAINT TRIGGER native_child_acceptance_complete AFTER INSERT ON app.workflow_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.trigger_type='workflow_call')
  EXECUTE FUNCTION app.check_native_child_acceptance_commit();

-- Current consumer inspection is separate from accepted historical metadata.
-- No lease/receipt mutation or row locks: bounded tenant read owner supplies
-- transaction/reply lifetime, while every source fetch independently repeats
-- this actual scope/revision/delivery/control proof.
CREATE FUNCTION app.inspect_native_coordinator_value_owner(p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_path uuid[];
  v_current uuid;
  v_now timestamptz:=clock_timestamp();
  v_deadline timestamptz;
  v_canceled boolean:=false;
BEGIN
  IF (jsonb_typeof(p_owner)='object'
    AND p_owner ?& ARRAY['workspaceId','runId','workflowVersionId','delivery','expectedRevision']
    AND p_owner-ARRAY['workspaceId','runId','workflowVersionId','delivery','expectedRevision']='{}'::jsonb
    AND p_owner->>'workspaceId'=v_workspace::text
    AND jsonb_typeof(p_owner->'delivery')='object'
    AND p_owner->'delivery' ?& ARRAY['outboxEventId','payloadChecksum']
    AND (p_owner->'delivery')-ARRAY['outboxEventId','payloadChecksum']='{}'::jsonb
    AND jsonb_typeof(p_owner->'expectedRevision')='number'
    AND (p_owner->>'expectedRevision')::numeric BETWEEN 0 AND 2147483646
    AND trunc((p_owner->>'expectedRevision')::numeric)=(p_owner->>'expectedRevision')::numeric) IS NOT TRUE THEN
    RAISE EXCEPTION 'native coordinator consumer scope is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
    AND run.id=(p_owner->>'runId')::uuid AND run.workflow_version_id=(p_owner->>'workflowVersionId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'native coordinator consumer run differs' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_version FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.workflow_id=v_run.workflow_id AND version.id=v_run.workflow_version_id;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint WHERE checkpoint.workspace_id=v_workspace
    AND checkpoint.workflow_run_id=v_run.id AND checkpoint.workflow_version_id=v_run.workflow_version_id;
  IF NOT FOUND OR (v_version.schema_version=2 AND v_version.executable_schema_version=3
    AND v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND v_checkpoint.scheduler_state->>'workflowVersionId'=v_run.workflow_version_id::text
    AND v_checkpoint.scheduler_state->'revision'=to_jsonb(v_checkpoint.revision)
    AND v_checkpoint.scheduler_state->>'runStatus'=v_run.status) IS NOT TRUE THEN
    RAISE EXCEPTION 'native coordinator consumer checkpoint differs' USING ERRCODE='23514';
  END IF;
  PERFORM app.assert_native_advance_delivery(v_run.id,(p_owner#>>'{delivery,outboxEventId}')::uuid,
    p_owner#>>'{delivery,payloadChecksum}');
  IF v_checkpoint.revision<>(p_owner->>'expectedRevision')::integer THEN
    RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','stale','revision',v_checkpoint.revision));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace AND workspace.status='active') THEN
    RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','unavailable','reason','control_read_failed'));
  END IF;
  v_path:=app.native_call_lineage(v_run.id);
  FOREACH v_current IN ARRAY v_path LOOP
    SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=v_current;
    IF NOT FOUND OR v_run.status NOT IN ('queued','running','waiting') THEN
      RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','unavailable','reason','control_read_failed'));
    END IF;
    v_canceled:=v_canceled OR v_run.cancel_requested_at IS NOT NULL;
    IF v_run.deadline_at IS NULL OR NOT isfinite(v_run.deadline_at) THEN
      RAISE EXCEPTION 'native coordinator consumer deadline differs' USING ERRCODE='23514';
    END IF;
    v_deadline:=least(v_deadline,v_run.deadline_at);
  END LOOP;
  v_now:=clock_timestamp();
  IF v_canceled THEN RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','canceled')); END IF;
  IF v_deadline<=v_now THEN RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','timed_out')); END IF;
  RETURN jsonb_build_object('kind','active','databaseNow',v_now,'deadlineAt',v_deadline);
END $$;
REVOKE ALL ON FUNCTION app.inspect_native_coordinator_value_owner(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.inspect_native_coordinator_value_owner(jsonb) TO {{worker_runtime_role}};

-- Independent bounded interpretation of the existing callable descriptor
-- grammar, not a second JSON encoder or a caller-supplied validation label.
-- PostgreSQL/JS differential qualification remains OPEN and mandatory.
CREATE FUNCTION app.assert_native_callable_value(p_descriptor jsonb,p_value jsonb)
RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $$
DECLARE
  v_descriptor jsonb;
  v_value jsonb;
  v_type text;
  v_entry record;
  v_number double precision;
  v_count integer:=0;
BEGIN
  FOR v_entry IN WITH RECURSIVE descriptors(descriptor,depth) AS (
    SELECT p_descriptor,1 UNION ALL
    SELECT child.descriptor,descriptors.depth+1 FROM descriptors
      CROSS JOIN LATERAL (
        SELECT descriptors.descriptor->'items' AS descriptor
          WHERE descriptors.descriptor->>'type'='array'
        UNION ALL SELECT property.value FROM jsonb_each(
          CASE WHEN jsonb_typeof(descriptors.descriptor->'properties')='object'
            THEN descriptors.descriptor->'properties' ELSE '{}'::jsonb END) property
          WHERE descriptors.descriptor->>'type'='object'
      ) child WHERE descriptors.depth<9
  ) SELECT * FROM descriptors
  LOOP
    v_count:=v_count+1;
    v_descriptor:=v_entry.descriptor;
    v_type:=v_descriptor->>'type';
    IF v_count>256 OR v_entry.depth>8 OR jsonb_typeof(v_descriptor) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'native callable descriptor bounds differ' USING ERRCODE='23514';
    END IF;
    IF v_type IN ('string','number','integer','boolean','null') THEN
      IF v_descriptor-ARRAY['type']<>'{}'::jsonb THEN
        RAISE EXCEPTION 'native callable primitive descriptor differs' USING ERRCODE='23514';
      END IF;
    ELSIF v_type='array' THEN
      IF (v_descriptor ?& ARRAY['type','items','maxItems']
        AND v_descriptor-ARRAY['type','items','maxItems']='{}'::jsonb
        AND jsonb_typeof(v_descriptor->'maxItems')='number'
        AND (v_descriptor->>'maxItems')::numeric BETWEEN 1 AND 1000
        AND trunc((v_descriptor->>'maxItems')::numeric)=(v_descriptor->>'maxItems')::numeric) IS NOT TRUE THEN
        RAISE EXCEPTION 'native callable array descriptor differs' USING ERRCODE='23514';
      END IF;
    ELSIF v_type='object' THEN
      IF (v_descriptor ?& ARRAY['type','properties','required']
        AND v_descriptor-ARRAY['type','properties','required']='{}'::jsonb
        AND jsonb_typeof(v_descriptor->'properties')='object'
        AND jsonb_typeof(v_descriptor->'required')='array') IS NOT TRUE THEN
        RAISE EXCEPTION 'native callable object descriptor differs' USING ERRCODE='23514';
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(v_descriptor->'properties'))>128
        OR jsonb_array_length(v_descriptor->'required')>128
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_descriptor->'properties') name
          WHERE name !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' OR name IN ('__proto__','prototype','constructor'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_descriptor->'required') name
          WHERE jsonb_typeof(name)<>'string' OR NOT (v_descriptor->'properties' ? (name#>>'{}')))
        OR (SELECT count(*)<>count(DISTINCT name) FROM jsonb_array_elements(v_descriptor->'required') name) THEN
        RAISE EXCEPTION 'native callable object properties differ' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'native callable descriptor type differs' USING ERRCODE='23514'; END IF;
  END LOOP;
  v_count:=0;
  FOR v_entry IN WITH RECURSIVE values_to_check(descriptor,value,depth) AS (
    SELECT p_descriptor,p_value,1 UNION ALL
    SELECT child.descriptor,child.value,values_to_check.depth+1 FROM values_to_check
      CROSS JOIN LATERAL (
        SELECT values_to_check.descriptor->'items' AS descriptor,element AS value
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(values_to_check.value)='array'
            THEN values_to_check.value ELSE '[]'::jsonb END) element
          WHERE values_to_check.descriptor->>'type'='array'
        UNION ALL SELECT values_to_check.descriptor->'properties'->property.key,property.value
          FROM jsonb_each(CASE WHEN jsonb_typeof(values_to_check.value)='object'
            THEN values_to_check.value ELSE '{}'::jsonb END) property
          WHERE values_to_check.descriptor->>'type'='object'
      ) child WHERE values_to_check.depth<65
  ) SELECT * FROM values_to_check
  LOOP
    v_count:=v_count+1;
    v_descriptor:=v_entry.descriptor; v_value:=v_entry.value; v_type:=v_descriptor->>'type';
    IF v_count>10001 OR v_entry.depth>64 OR v_type IS NULL
      OR jsonb_typeof(v_value) IS DISTINCT FROM (CASE WHEN v_type='integer' THEN 'number' ELSE v_type END) THEN
      RAISE EXCEPTION 'native callable value type differs' USING ERRCODE='23514';
    END IF;
    IF v_type IN ('number','integer') THEN
      v_number:=app.native_execution_value_binary64_leaf(v_value#>>'{}');
      IF v_type='integer' AND trunc(v_number)<>v_number THEN
        RAISE EXCEPTION 'native callable value integer differs' USING ERRCODE='23514';
      END IF;
    ELSIF v_type='array' AND jsonb_array_length(v_value)>(v_descriptor->>'maxItems')::integer THEN
      RAISE EXCEPTION 'native callable value array exceeds bound' USING ERRCODE='23514';
    ELSIF v_type='object' AND (
      EXISTS(SELECT 1 FROM jsonb_object_keys(v_value) name WHERE NOT (v_descriptor->'properties' ? name))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_descriptor->'required') name WHERE NOT (v_value ? name))) THEN
      RAISE EXCEPTION 'native callable value properties differ' USING ERRCODE='23514';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.assert_native_callable_value(jsonb,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Inline terminal production under the EXISTING CAS/receipt transaction. The
-- bounded original identity record supplies comparison bytes only; actual
-- immutable selector, revisions, receipt, sources and controls are re-derived.
-- Minimum native path supports literal and whole-value run_input/node_output.
-- Expressions/other paths/artifacts remain explicit unavailable source gates,
-- never a fabricated child_result_invalid or an alternate serializer.
CREATE FUNCTION app.record_workflow_call_run_result(
  p_run uuid,p_revision integer,p_delivery jsonb,p_reference jsonb,
  p_sha256 text,p_byte_length integer,p_original text,p_sources jsonb,p_identity_original text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_ancestor app.workflow_runs%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_child_checkpoint app.run_checkpoints%ROWTYPE;
  v_child app.workflow_runs%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_input app.workflow_execution_value_provenance%ROWTYPE;
  v_source app.workflow_execution_value_provenance%ROWTYPE;
  v_existing app.workflow_execution_value_provenance%ROWTYPE;
  v_identity jsonb;
  v_identity_sha text;
  v_selector jsonb;
  v_selected jsonb;
  v_invocation jsonb;
  v_matches integer;
  v_path uuid[];
  v_current uuid;
  v_deadline timestamptz;
  v_source_until timestamptz;
  v_accepted_at timestamptz:=clock_timestamp();
BEGIN
  IF (p_revision BETWEEN 1 AND 2147483647 AND jsonb_typeof(p_delivery)='object'
    AND p_delivery ?& ARRAY['outboxEventId','payloadChecksum']
    AND p_delivery-ARRAY['outboxEventId','payloadChecksum']='{}'::jsonb
    AND jsonb_typeof(p_reference)='object' AND p_reference->'schemaVersion'='1'::jsonb
    AND p_reference->>'kind'='inline' AND p_reference ? 'value'
    AND p_reference-ARRAY['schemaVersion','kind','value']='{}'::jsonb
    AND jsonb_typeof(p_sources)='array' AND jsonb_array_length(p_sources)<=1000
    AND octet_length(p_identity_original) BETWEEN 1 AND 1048576
    AND p_identity_original IS JSON OBJECT WITH UNIQUE KEYS) IS NOT TRUE THEN
    RAISE EXCEPTION 'native terminal result envelope is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app.assert_native_inline_execution_value_bytes(p_reference->'value',p_sha256,p_byte_length,p_original);
  PERFORM app.assert_native_advance_delivery(p_run,(p_delivery->>'outboxEventId')::uuid,p_delivery->>'payloadChecksum');
  IF NOT EXISTS(SELECT 1 FROM app.inbox_receipts receipt WHERE receipt.workspace_id=v_workspace
    AND receipt.consumer_name='workflow-coordinator' AND receipt.message_id=(p_delivery->>'outboxEventId')::uuid
    AND receipt.payload_checksum=p_delivery->>'payloadChecksum' AND receipt.completed_at IS NULL) THEN
    RAISE EXCEPTION 'native terminal result current receipt differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=p_run;
  IF NOT FOUND OR (v_run.status='succeeded' AND v_run.completed_at IS NOT NULL
    AND v_run.cancel_requested_at IS NULL AND isfinite(v_run.deadline_at)
    AND v_run.deadline_at>clock_timestamp()) IS NOT TRUE THEN
    RAISE EXCEPTION 'native terminal result actual run differs' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_version FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.workflow_id=v_run.workflow_id AND version.id=v_run.workflow_version_id;
  IF NOT FOUND OR (v_version.schema_version=2 AND v_version.executable_schema_version=3
    AND v_version.executable_json#>'{graph,callable,schemaVersion}'='1'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native terminal result immutable declaration differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint WHERE checkpoint.workspace_id=v_workspace
    AND checkpoint.workflow_run_id=p_run AND checkpoint.workflow_version_id=v_run.workflow_version_id;
  IF NOT FOUND OR (v_checkpoint.revision=p_revision AND v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND v_checkpoint.scheduler_state->'revision'=to_jsonb(p_revision)
    AND v_checkpoint.scheduler_state->>'workflowVersionId'=v_run.workflow_version_id::text
    AND v_checkpoint.scheduler_state->>'runStatus'='succeeded'
    AND v_checkpoint.last_transition_fingerprint ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
    RAISE EXCEPTION 'native terminal result post-CAS checkpoint differs' USING ERRCODE='23514';
  END IF;
  -- Presence is not authority: existing full-plan equality/recovery stays at
  -- canonical CAS. No full fingerprint is copied into result identity/provenance.
  IF NOT EXISTS(SELECT 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace AND workspace.status='active') THEN
    RAISE EXCEPTION 'native terminal result workspace is inactive' USING ERRCODE='55000';
  END IF;
  v_path:=app.native_call_lineage(p_run);
  FOREACH v_current IN ARRAY v_path LOOP
    SELECT * INTO v_ancestor FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=v_current;
    IF NOT FOUND OR (v_ancestor.cancel_requested_at IS NULL AND isfinite(v_ancestor.deadline_at)
      AND v_ancestor.deadline_at>clock_timestamp()
      AND ((v_current=p_run AND v_ancestor.status='succeeded')
        OR (v_current<>p_run AND v_ancestor.status IN ('queued','running','waiting')))) IS NOT TRUE THEN
      RAISE EXCEPTION 'native terminal result family control differs' USING ERRCODE='55000';
    END IF;
    v_deadline:=least(v_deadline,v_ancestor.deadline_at);
  END LOOP;
  v_selector:=v_version.executable_json#>'{graph,callable,resultSelector}';
  PERFORM app.assert_native_callable_value(v_version.executable_json#>'{graph,callable,result}',p_reference->'value');
  IF v_selector->>'kind'='literal' THEN
    IF p_sources<>'[]'::jsonb THEN RAISE EXCEPTION 'native literal result source inventory differs' USING ERRCODE='23514'; END IF;
    v_selected:=v_selector->'value';
  ELSIF v_selector->>'kind'='run_input' AND v_selector->>'path'='$' THEN
    IF p_sources<>'[]'::jsonb THEN RAISE EXCEPTION 'native input result source inventory differs' USING ERRCODE='23514'; END IF;
    SELECT * INTO v_input FROM app.workflow_execution_value_provenance input
      WHERE input.workspace_id=v_workspace AND input.workflow_run_id=p_run
        AND input.workflow_version_id=v_run.workflow_version_id AND input.value_slot='run_input'
        AND input.eligibility_revoked_at IS NULL AND input.eligible_until>clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'native result accepted run input is unavailable' USING ERRCODE='55000'; END IF;
    IF v_input.byte_ownership='owned' THEN v_source:=v_input;
    ELSE
      SELECT source.* INTO v_source FROM app.workflow_execution_value_provenance source
        JOIN app.workflow_calls call ON call.workspace_id=v_workspace AND call.id=v_input.borrowed_workflow_call_id
          AND call.child_run_id=p_run AND call.child_workflow_version_id=v_run.workflow_version_id
          AND call.outcome_kind='admitted' AND call.sealed
          AND call.declaration_input_provenance_id=source.id
        WHERE source.workspace_id=v_workspace AND source.id=v_input.borrowed_from_provenance_id
          AND source.value_slot='attempt_input' AND source.byte_ownership='owned';
    END IF;
    IF v_source.id IS NULL OR v_source.eligibility_revoked_at IS NOT NULL
      OR v_source.eligible_until<=clock_timestamp() OR v_source.original_reference::text IS DISTINCT FROM v_run.input_ref::text THEN
      RAISE EXCEPTION 'native result original run input differs' USING ERRCODE='55000';
    END IF;
    v_source_until:=least(v_input.eligible_until,v_source.eligible_until);
    v_selected:=v_source.original_reference->'value';
  ELSIF v_selector->>'kind'='node_output' AND v_selector->>'path'='$' THEN
    IF (SELECT count(*) FROM jsonb_array_elements(v_version.executable_json#>'{graph,nodes}') node
      WHERE node->>'id'=v_selector->>'nodeId')<>1 THEN
      RAISE EXCEPTION 'native result selected root node differs' USING ERRCODE='23514';
    END IF;
    SELECT count(*)::integer,(jsonb_agg(invocation))->0 INTO v_matches,v_invocation
      FROM jsonb_array_elements(v_checkpoint.scheduler_state->'invocations') invocation
      WHERE invocation->>'nodeId'=v_selector->>'nodeId' AND invocation->>'status'='succeeded';
    IF v_matches<>1 OR p_sources IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
      'invocationKey',v_invocation->'invocationKey','output',v_invocation->'output')) THEN
      RAISE EXCEPTION 'native result selected invocation differs' USING ERRCODE='23514';
    END IF;
    IF v_invocation#>>'{output,kind}'='workflow_call' THEN
      SELECT * INTO v_call FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
        AND call.parent_run_id=p_run AND call.parent_workflow_version_id=v_run.workflow_version_id
        AND call.invocation_key=v_invocation->>'invocationKey' AND call.node_id=v_selector->>'nodeId'
        AND call.child_run_id=(v_invocation#>>'{output,childRunId}')::uuid
        AND v_invocation#>>'{output,invocationKey}'=call.invocation_key AND call.outcome_kind='admitted' AND call.sealed;
      IF NOT FOUND THEN RAISE EXCEPTION 'native result selected child journal differs' USING ERRCODE='23514'; END IF;
      SELECT * INTO v_child FROM app.workflow_runs child WHERE child.workspace_id=v_workspace
        AND child.id=v_call.child_run_id AND child.workflow_version_id=v_call.child_workflow_version_id
        AND child.workflow_id=v_call.callee_workflow_id AND child.trigger_type='workflow_call' AND child.status='succeeded';
      IF NOT FOUND THEN RAISE EXCEPTION 'native result selected child is not successful' USING ERRCODE='55000'; END IF;
      SELECT * INTO v_child_checkpoint FROM app.run_checkpoints checkpoint WHERE checkpoint.workspace_id=v_workspace
        AND checkpoint.workflow_run_id=v_child.id AND checkpoint.workflow_version_id=v_child.workflow_version_id;
      SELECT * INTO v_source FROM app.workflow_execution_value_provenance source WHERE source.workspace_id=v_workspace
        AND source.workflow_run_id=v_child.id AND source.workflow_version_id=v_child.workflow_version_id
        AND source.value_slot='run_result' AND source.byte_ownership='owned'
        AND source.accepted_revision=v_child_checkpoint.revision
        AND v_child_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
        AND v_child_checkpoint.scheduler_state->'revision'=to_jsonb(v_child_checkpoint.revision)
        AND v_child_checkpoint.scheduler_state->>'runStatus'='succeeded'
        AND source.original_reference::text=v_child.output_ref::text;
    ELSE
      SELECT source.* INTO v_source FROM app.workflow_execution_value_provenance source
        JOIN app.node_runs node ON node.workspace_id=source.workspace_id AND node.id=source.node_run_id
          AND node.workflow_run_id=p_run AND node.current_attempt_id=source.attempt_id AND node.status='succeeded'
        JOIN app.node_attempts attempt ON attempt.workspace_id=source.workspace_id AND attempt.id=source.attempt_id
          AND attempt.node_run_id=node.id AND attempt.status='succeeded' AND attempt.completed_at IS NOT NULL
          AND attempt.lease_owner IS NULL AND attempt.lease_expires_at IS NULL
        WHERE source.workspace_id=v_workspace AND source.workflow_run_id=p_run
          AND source.workflow_version_id=v_run.workflow_version_id AND source.node_id=v_selector->>'nodeId'
          AND source.invocation_key=v_invocation->>'invocationKey'
          AND source.value_slot='attempt_output' AND source.byte_ownership='owned'
          AND v_invocation#>>'{output,kind}'='inline'
          AND source.attempt_id=(v_invocation#>>'{output,attemptId}')::uuid
          AND source.original_reference::text=attempt.output_ref::text AND source.original_reference::text=node.output_ref::text;
    END IF;
    IF v_source.id IS NULL OR v_source.eligibility_revoked_at IS NOT NULL OR v_source.eligible_until<=clock_timestamp() THEN
      RAISE EXCEPTION 'native result selected accepted source is unavailable' USING ERRCODE='55000';
    END IF;
    v_source_until:=v_source.eligible_until; v_selected:=v_source.original_reference->'value';
  ELSE RAISE EXCEPTION 'native result selector preparation is unavailable' USING ERRCODE='55000'; END IF;
  IF v_source.id IS NOT NULL AND v_source.reference_kind<>'inline' THEN
    RAISE EXCEPTION 'native result selected artifact preparation is unavailable' USING ERRCODE='55000';
  END IF;
  -- Per-leaf binary64 agreement, not PostgreSQL numeric equality or re-encoding.
  PERFORM app.assert_native_inline_execution_value_bytes(v_selected,p_sha256,p_byte_length,p_original);
  v_identity:=p_identity_original::jsonb;
  IF (v_identity ?& ARRAY['schemaVersion','slot','workspaceId','runId','workflowVersionId',
      'delivery','expectedRevision','resultRevision','resultSelector','sources','value']
    AND v_identity-ARRAY['schemaVersion','slot','workspaceId','runId','workflowVersionId',
      'delivery','expectedRevision','resultRevision','resultSelector','sources','value']='{}'::jsonb
    AND v_identity->'schemaVersion'='1'::jsonb AND v_identity->>'slot'='run_result'
    AND v_identity->>'workspaceId'=v_workspace::text AND v_identity->>'runId'=p_run::text
    AND v_identity->>'workflowVersionId'=v_run.workflow_version_id::text
    AND v_identity->'delivery'=p_delivery AND v_identity->'expectedRevision'=to_jsonb(p_revision-1)
    AND v_identity->'resultRevision'=to_jsonb(p_revision) AND v_identity->'resultSelector'=v_selector
    AND v_identity->'sources'=p_sources AND v_identity->'value'=jsonb_build_object(
      'sha256',p_sha256,'byteLength',p_byte_length,'mediaType','application/vnd.pertexo.execution-value+json;version=1')) IS NOT TRUE THEN
    RAISE EXCEPTION 'native result original content binding differs' USING ERRCODE='23514';
  END IF;
  v_identity_sha:=encode(sha256(convert_to(p_identity_original,'UTF8')),'hex');
  SELECT * INTO v_existing FROM app.workflow_execution_value_provenance provenance
    WHERE provenance.workspace_id=v_workspace AND provenance.workflow_run_id=p_run AND provenance.value_slot='run_result';
  IF FOUND THEN
    IF (v_existing.workflow_version_id=v_run.workflow_version_id AND v_existing.accepted_revision=p_revision
      AND v_existing.coordinator_result_identity=v_identity_sha
      AND v_existing.delivery_outbox_event_id=(p_delivery->>'outboxEventId')::uuid
      AND v_existing.delivery_payload_checksum=p_delivery->>'payloadChecksum'
      AND v_existing.original_inline_text=p_original AND v_existing.sha256=p_sha256 AND v_existing.byte_length=p_byte_length
      AND v_existing.eligibility_revoked_at IS NULL AND v_existing.eligible_until>clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'native terminal result immutable identity differs' USING ERRCODE='23514';
    END IF;
  ELSE
    INSERT INTO app.workflow_execution_value_provenance (
      id,workspace_id,workflow_run_id,workflow_version_id,value_slot,byte_ownership,
      accepted_revision,coordinator_result_identity,delivery_outbox_event_id,delivery_payload_checksum,
      reference_kind,original_reference,original_inline_text,sha256,byte_length,media_type,accepted_at,eligible_until
    ) VALUES(gen_random_uuid(),v_workspace,p_run,v_run.workflow_version_id,'run_result','owned',
      p_revision,v_identity_sha,(p_delivery->>'outboxEventId')::uuid,p_delivery->>'payloadChecksum',
      'inline',p_reference,p_original,p_sha256,p_byte_length,'application/vnd.pertexo.execution-value+json;version=1',
      v_accepted_at,v_accepted_at+interval '30 days') RETURNING * INTO v_existing;
  END IF;
  UPDATE app.workflow_runs run SET output_ref=v_existing.original_reference,updated_at=clock_timestamp()
    WHERE run.workspace_id=v_workspace AND run.id=p_run
      AND (run.output_ref IS NULL OR run.output_ref::text=v_existing.original_reference::text);
  IF NOT FOUND THEN RAISE EXCEPTION 'native terminal first result projection differs' USING ERRCODE='23514'; END IF;
  IF v_deadline<=clock_timestamp() OR v_source_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'native terminal result source/control expired during acceptance' USING ERRCODE='55000';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.record_workflow_call_run_result(uuid,integer,jsonb,jsonb,text,integer,text,jsonb,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.record_workflow_call_run_result(uuid,integer,jsonb,jsonb,text,integer,text,jsonb,text)
  TO {{worker_runtime_role}};

-- Private accepted-result truth, independent of CURRENT consumer authorization.
-- Historical queue rows are deliberately not retained/read here. Acceptance
-- already proved them atomically; protected immutable provenance binds exact
-- terminal checkpoint/run and sealed journal. No uncertain-COMMIT inference.
CREATE FUNCTION app.native_workflow_call_result_provenance(p_parent uuid,p_invocation text,p_child uuid)
RETURNS app.workflow_execution_value_provenance LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_result app.workflow_execution_value_provenance%ROWTYPE;
BEGIN
  IF p_parent IS NULL OR p_child IS NULL OR octet_length(p_invocation) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'native accepted-result identity is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app.assert_native_call_detail_live(p_parent);
  PERFORM app.assert_native_call_detail_live(p_child);
  SELECT result.* INTO v_result FROM app.workflow_calls call
    JOIN app.workflow_runs parent ON parent.workspace_id=call.workspace_id AND parent.id=call.parent_run_id
      AND parent.workflow_version_id=call.parent_workflow_version_id
    JOIN app.workflow_runs child ON child.workspace_id=call.workspace_id AND child.id=call.child_run_id
      AND child.workflow_id=call.callee_workflow_id AND child.workflow_version_id=call.child_workflow_version_id
      AND child.trigger_type='workflow_call' AND child.status='succeeded' AND child.completed_at IS NOT NULL
    JOIN app.run_checkpoints checkpoint ON checkpoint.workspace_id=child.workspace_id AND checkpoint.workflow_run_id=child.id
      AND checkpoint.workflow_version_id=child.workflow_version_id
    JOIN app.workflow_execution_value_provenance result ON result.workspace_id=child.workspace_id
      AND result.workflow_run_id=child.id AND result.workflow_version_id=child.workflow_version_id
      AND result.value_slot='run_result' AND result.byte_ownership='owned' AND result.accepted_revision=checkpoint.revision
    WHERE call.workspace_id=v_workspace AND call.parent_run_id=p_parent AND call.invocation_key=p_invocation
      AND call.child_run_id=p_child AND call.outcome_kind='admitted' AND call.sealed
      AND checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
      AND checkpoint.scheduler_state->'revision'=to_jsonb(checkpoint.revision)
      AND checkpoint.scheduler_state->>'workflowVersionId'=child.workflow_version_id::text
      AND checkpoint.scheduler_state->>'runStatus'='succeeded'
      AND result.original_reference::text=child.output_ref::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'native accepted child-result truth is unavailable' USING ERRCODE='55000'; END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION app.native_workflow_call_result_provenance(uuid,text,uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

-- Identity-only checkpoint validation: no inline bytes/locator/reference is
-- returned and expiry/revocation cannot fabricate a current payload grant.
CREATE FUNCTION app.assert_workflow_call_result_output(p_parent uuid,p_invocation text,p_child uuid,p_compare_node boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_result app.workflow_execution_value_provenance%ROWTYPE;
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  v_result:=app.native_workflow_call_result_provenance(p_parent,p_invocation,p_child);
  IF p_compare_node IS NULL THEN RAISE EXCEPTION 'native result comparison mode is invalid' USING ERRCODE='22023'; END IF;
  IF NOT p_compare_node THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM app.workflow_calls call JOIN app.node_runs node
    ON node.workspace_id=call.workspace_id AND node.id=call.node_run_id
      AND node.workflow_run_id=call.parent_run_id AND node.node_id=call.node_id AND node.invocation_key=call.invocation_key
    JOIN app.node_attempts attempt ON attempt.workspace_id=node.workspace_id AND attempt.id=node.current_attempt_id
      AND attempt.id=call.declaration_attempt_id AND attempt.node_run_id=node.id AND attempt.status='succeeded'
    WHERE call.workspace_id=v_workspace AND call.parent_run_id=p_parent AND call.invocation_key=p_invocation
      AND call.child_run_id=p_child AND call.outcome_kind='admitted' AND call.sealed
      AND node.status='succeeded' AND node.output_ref::text=v_result.original_reference::text);
END $$;
REVOKE ALL ON FUNCTION app.assert_workflow_call_result_output(uuid,text,uuid,boolean)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.assert_workflow_call_result_output(uuid,text,uuid,boolean) TO {{worker_runtime_role}};

CREATE FUNCTION app.read_workflow_call_result_reference(p_parent uuid,p_invocation text,p_child uuid,p_consumer jsonb)
RETURNS TABLE(reference_json text,serialized_value text,byte_length integer,value_checksum text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_inspection jsonb;
  v_result app.workflow_execution_value_provenance%ROWTYPE;
BEGIN
  IF p_consumer->>'runId' IS DISTINCT FROM p_parent::text THEN
    RAISE EXCEPTION 'native child-result consumer parent differs' USING ERRCODE='22023';
  END IF;
  v_inspection:=app.inspect_native_coordinator_value_owner(p_consumer);
  IF v_inspection->>'kind'<>'active' THEN
    RAISE EXCEPTION 'native child-result current consumer is stopped' USING ERRCODE='55000';
  END IF;
  v_result:=app.native_workflow_call_result_provenance(p_parent,p_invocation,p_child);
  IF v_result.eligibility_revoked_at IS NOT NULL OR v_result.eligible_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'native accepted child-result eligibility expired' USING ERRCODE='55000';
  END IF;
  IF v_result.reference_kind='artifact' THEN
    IF NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_artifact_associations association
      JOIN app.workflow_execution_value_artifact_candidates candidate ON candidate.workspace_id=association.workspace_id
        AND candidate.id=association.candidate_id AND candidate.abandoned_at IS NULL
      JOIN app.artifacts artifact ON artifact.workspace_id=association.workspace_id AND artifact.id=association.artifact_id
        AND artifact.status='available' AND artifact.deleted_at IS NULL AND artifact.expires_at>clock_timestamp()
        AND artifact.sha256=v_result.sha256 AND artifact.byte_length=v_result.byte_length AND artifact.media_type=v_result.media_type
      WHERE association.workspace_id=v_result.workspace_id AND association.provenance_id=v_result.id
        AND association.artifact_id=v_result.artifact_id) THEN
      RAISE EXCEPTION 'native accepted child-result artifact is unavailable' USING ERRCODE='55000';
    END IF;
  ELSE
    PERFORM app.assert_native_inline_execution_value_bytes(v_result.original_reference->'value',
      v_result.sha256,v_result.byte_length,v_result.original_inline_text);
  END IF;
  IF v_result.eligible_until<=clock_timestamp()
    OR (v_inspection->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'native accepted child-result source/control expired during read' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT v_result.original_reference::text,v_result.original_inline_text,
    v_result.byte_length,v_result.sha256::text;
END $$;
REVOKE ALL ON FUNCTION app.read_workflow_call_result_reference(uuid,text,uuid,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.read_workflow_call_result_reference(uuid,text,uuid,jsonb) TO {{worker_runtime_role}};

-- Private metadata inventory derived from immutable selector/current checkpoint.
-- No original inline text/value is emitted. The minimum whole-value selector
-- path is deliberate; isolated expressions/general paths stay unavailable until
-- their actual bounded source inspection/preparation owner is composed.
CREATE FUNCTION app.native_coordinator_value_inventory(p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=(p_owner->>'workspaceId')::uuid;
  v_run app.workflow_runs%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_input app.workflow_execution_value_provenance%ROWTYPE;
  v_value app.workflow_execution_value_provenance%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_selector jsonb;
  v_invocation jsonb;
  v_source jsonb;
  v_identity jsonb;
  v_matches integer;
  v_run_input jsonb:='null'::jsonb;
  v_outputs jsonb:='[]'::jsonb;
BEGIN
  SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=(p_owner->>'runId')::uuid;
  SELECT * INTO v_version FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.id=v_run.workflow_version_id AND version.workflow_id=v_run.workflow_id;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint WHERE checkpoint.workspace_id=v_workspace
    AND checkpoint.workflow_run_id=v_run.id AND checkpoint.workflow_version_id=v_run.workflow_version_id;
  v_selector:=v_version.executable_json#>'{graph,callable,resultSelector}';
  IF v_selector->>'kind'='literal' THEN
    RETURN jsonb_build_object('runInput',v_run_input,'outputs',v_outputs);
  ELSIF v_selector->>'kind'='run_input' AND v_selector->>'path'='$' THEN
    IF v_run.input_ref IS NULL THEN RETURN jsonb_build_object('runInput',v_run_input,'outputs',v_outputs); END IF;
    SELECT * INTO v_input FROM app.workflow_execution_value_provenance input WHERE input.workspace_id=v_workspace
      AND input.workflow_run_id=v_run.id AND input.workflow_version_id=v_run.workflow_version_id
      AND input.value_slot='run_input' AND input.eligibility_revoked_at IS NULL AND input.eligible_until>clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'native inventory accepted input is unavailable' USING ERRCODE='55000'; END IF;
    IF v_input.byte_ownership='owned' THEN v_value:=v_input;
    ELSE
      SELECT source.* INTO v_value FROM app.workflow_execution_value_provenance source JOIN app.workflow_calls call
        ON call.workspace_id=v_workspace AND call.id=v_input.borrowed_workflow_call_id
          AND call.child_run_id=v_run.id AND call.child_workflow_version_id=v_run.workflow_version_id
          AND call.outcome_kind='admitted' AND call.sealed AND call.declaration_input_provenance_id=source.id
        WHERE source.workspace_id=v_workspace AND source.id=v_input.borrowed_from_provenance_id
          AND source.value_slot='attempt_input' AND source.byte_ownership='owned';
    END IF;
    IF v_value.id IS NULL OR v_value.eligibility_revoked_at IS NOT NULL OR v_value.eligible_until<=clock_timestamp()
      OR v_value.original_reference::text IS DISTINCT FROM v_run.input_ref::text THEN
      RAISE EXCEPTION 'native inventory borrowed input producer is unavailable' USING ERRCODE='55000';
    END IF;
    v_source:=jsonb_build_object('kind','run_input','workspaceId',v_workspace,'runId',v_run.id,
      'workflowVersionId',v_run.workflow_version_id,'provenanceId',v_input.id);
  ELSIF v_selector->>'kind'='node_output' AND v_selector->>'path'='$' THEN
    IF (SELECT count(*) FROM jsonb_array_elements(v_version.executable_json#>'{graph,nodes}') node
      WHERE node->>'id'=v_selector->>'nodeId')<>1 THEN
      RAISE EXCEPTION 'native inventory selected root node differs' USING ERRCODE='23514';
    END IF;
    SELECT count(*)::integer,(jsonb_agg(invocation))->0 INTO v_matches,v_invocation
      FROM jsonb_array_elements(v_checkpoint.scheduler_state->'invocations') invocation
      WHERE invocation->>'nodeId'=v_selector->>'nodeId' AND invocation->>'status' IN ('succeeded','waiting');
    IF v_matches<>1 THEN RAISE EXCEPTION 'native inventory selected invocation differs' USING ERRCODE='23514'; END IF;
    IF v_invocation->>'status'='waiting' THEN
      -- Pure demand may settle a just-terminal child BEFORE the parent CAS.
      -- Derive that logical source from sealed admitted truth/current Call wait,
      -- never mistake its succeeded declaration attempt/input for child output.
      SELECT call.* INTO v_call FROM app.workflow_calls call JOIN app.node_runs node
        ON node.workspace_id=call.workspace_id AND node.id=call.node_run_id
          AND node.workflow_run_id=call.parent_run_id AND node.node_id=call.node_id
          AND node.invocation_key=call.invocation_key AND node.status='waiting' AND node.control_kind='workflow_call'
        JOIN app.node_attempts attempt ON attempt.workspace_id=node.workspace_id AND attempt.id=call.declaration_attempt_id
          AND node.current_attempt_id=attempt.id AND attempt.node_run_id=node.id AND attempt.status='succeeded'
          AND attempt.attempt_number=call.declaration_attempt_number AND attempt.side_effect_class='unsafe'
        WHERE call.workspace_id=v_workspace AND call.parent_run_id=v_run.id
          AND call.parent_workflow_version_id=v_run.workflow_version_id AND call.node_id=v_selector->>'nodeId'
          AND call.invocation_key=v_invocation->>'invocationKey' AND call.outcome_kind='admitted' AND call.sealed;
      IF NOT FOUND THEN RAISE EXCEPTION 'native inventory logical wait differs' USING ERRCODE='23514'; END IF;
      v_value:=app.native_workflow_call_result_provenance(v_run.id,v_call.invocation_key,v_call.child_run_id);
      v_invocation:=v_invocation||jsonb_build_object('output',jsonb_build_object(
        'kind','workflow_call','invocationKey',v_call.invocation_key,'childRunId',v_call.child_run_id));
    END IF;
    IF v_invocation#>>'{output,kind}'='workflow_call' THEN
      SELECT * INTO v_call FROM app.workflow_calls call WHERE call.workspace_id=v_workspace AND call.parent_run_id=v_run.id
        AND call.parent_workflow_version_id=v_run.workflow_version_id AND call.node_id=v_selector->>'nodeId'
        AND call.invocation_key=v_invocation->>'invocationKey' AND call.outcome_kind='admitted' AND call.sealed
        AND call.child_run_id=(v_invocation#>>'{output,childRunId}')::uuid
        AND v_invocation#>>'{output,invocationKey}'=call.invocation_key;
      IF NOT FOUND THEN RAISE EXCEPTION 'native inventory child journal differs' USING ERRCODE='23514'; END IF;
      v_value:=app.native_workflow_call_result_provenance(v_run.id,v_call.invocation_key,v_call.child_run_id);
      v_source:=jsonb_build_object('kind','workflow_call_result','workspaceId',v_workspace,'provenanceId',v_value.id,
        'parentRunId',v_run.id,'parentWorkflowVersionId',v_run.workflow_version_id,'childRunId',v_call.child_run_id,
        'childWorkflowVersionId',v_call.child_workflow_version_id,'nodeId',v_call.node_id,'invocationKey',v_call.invocation_key);
    ELSE
      SELECT source.* INTO v_value FROM app.workflow_execution_value_provenance source
        JOIN app.node_runs node ON node.workspace_id=source.workspace_id AND node.id=source.node_run_id
          AND node.workflow_run_id=v_run.id AND node.current_attempt_id=source.attempt_id AND node.status='succeeded'
        JOIN app.node_attempts attempt ON attempt.workspace_id=node.workspace_id AND attempt.id=source.attempt_id
          AND attempt.node_run_id=node.id AND attempt.status='succeeded' AND attempt.completed_at IS NOT NULL
          AND attempt.lease_owner IS NULL AND attempt.lease_expires_at IS NULL
        WHERE source.workspace_id=v_workspace AND source.workflow_run_id=v_run.id
          AND source.workflow_version_id=v_run.workflow_version_id AND source.node_id=v_selector->>'nodeId'
          AND source.invocation_key=v_invocation->>'invocationKey' AND source.value_slot='attempt_output' AND source.byte_ownership='owned'
          AND ((v_invocation#>>'{output,kind}'='inline' AND source.reference_kind='inline'
              AND source.attempt_id=(v_invocation#>>'{output,attemptId}')::uuid)
            OR (v_invocation#>>'{output,kind}'='artifact' AND source.reference_kind='artifact'
              AND source.artifact_id=(v_invocation#>>'{output,artifactId}')::uuid))
          AND source.original_reference::text=attempt.output_ref::text AND source.original_reference::text=node.output_ref::text;
      IF NOT FOUND THEN RAISE EXCEPTION 'native inventory physical producer differs' USING ERRCODE='55000'; END IF;
      v_source:=jsonb_build_object('kind','physical_output','workspaceId',v_workspace,'runId',v_run.id,
        'workflowVersionId',v_run.workflow_version_id,'provenanceId',v_value.id,'nodeId',v_value.node_id,
        'invocationKey',v_value.invocation_key,'attemptId',v_value.attempt_id);
    END IF;
  ELSE RAISE EXCEPTION 'native inventory selector preparation is unavailable' USING ERRCODE='55000'; END IF;
  IF v_value.eligibility_revoked_at IS NOT NULL OR v_value.eligible_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'native inventory accepted source is unavailable' USING ERRCODE='55000';
  END IF;
  IF v_value.reference_kind='artifact' AND NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_artifact_associations association
    JOIN app.workflow_execution_value_artifact_candidates candidate ON candidate.workspace_id=association.workspace_id
      AND candidate.id=association.candidate_id AND candidate.abandoned_at IS NULL
    JOIN app.artifacts artifact ON artifact.workspace_id=association.workspace_id AND artifact.id=association.artifact_id
      AND artifact.status='available' AND artifact.deleted_at IS NULL AND artifact.expires_at>clock_timestamp()
      AND artifact.sha256=v_value.sha256 AND artifact.byte_length=v_value.byte_length AND artifact.media_type=v_value.media_type
    WHERE association.workspace_id=v_workspace AND association.provenance_id=v_value.id AND association.artifact_id=v_value.artifact_id) THEN
    RAISE EXCEPTION 'native inventory accepted artifact is unavailable' USING ERRCODE='55000';
  END IF;
  v_identity:=jsonb_build_object('reference',CASE WHEN v_value.reference_kind='inline' THEN
      jsonb_build_object('schemaVersion',1,'kind','inline') ELSE
      jsonb_build_object('schemaVersion',1,'kind','artifact','artifactId',v_value.artifact_id) END,
    'sha256',v_value.sha256,'byteLength',v_value.byte_length,'mediaType',v_value.media_type);
  IF v_selector->>'kind'='run_input' THEN
    v_run_input:=jsonb_build_object('slot','run_input','source',v_source,'valueIdentity',v_identity);
  ELSE
    v_outputs:=jsonb_build_array(jsonb_build_object('invocationKey',v_invocation->'invocationKey',
      'output',v_invocation->'output','valueSource',jsonb_build_object('slot','upstream_output','source',v_source,'valueIdentity',v_identity)));
  END IF;
  RETURN jsonb_build_object('runInput',v_run_input,'outputs',v_outputs);
END $$;
REVOKE ALL ON FUNCTION app.native_coordinator_value_inventory(jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};

CREATE FUNCTION app.load_native_coordinator_value_sources(p_owner jsonb,p_demand jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_inspection jsonb; v_inventory jsonb; v_selector jsonb; v_expected jsonb;
BEGIN
  v_inspection:=app.inspect_native_coordinator_value_owner(p_owner);
  IF v_inspection->>'kind'='stopped' THEN RETURN v_inspection; END IF;
  SELECT version.executable_json#>'{graph,callable,resultSelector}' INTO v_selector FROM app.workflow_versions version
    WHERE version.workspace_id=(p_owner->>'workspaceId')::uuid AND version.id=(p_owner->>'workflowVersionId')::uuid;
  v_inventory:=app.native_coordinator_value_inventory(p_owner);
  SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId',entry#>'{valueSource,source,nodeId}',
    'invocationKey',entry->'invocationKey','output',entry->'output') ORDER BY ordinal),'[]'::jsonb)
    INTO v_expected FROM jsonb_array_elements(v_inventory->'outputs') WITH ORDINALITY entries(entry,ordinal);
  IF p_demand IS DISTINCT FROM jsonb_build_object('expectedRevision',p_owner->'expectedRevision',
    'resultSelector',v_selector,'requiresRunInput',v_selector->>'kind'='run_input','sources',v_expected) THEN
    RAISE EXCEPTION 'native coordinator actual demand differs' USING ERRCODE='23514';
  END IF;
  IF (v_inspection->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','timed_out'));
  END IF;
  RETURN jsonb_build_object('kind','ready','projection',v_inventory);
END $$;
REVOKE ALL ON FUNCTION app.load_native_coordinator_value_sources(jsonb,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.load_native_coordinator_value_sources(jsonb,jsonb) TO {{worker_runtime_role}};

CREATE FUNCTION app.read_native_coordinator_value_source(p_owner jsonb,p_descriptor jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_inspection jsonb;
  v_inventory jsonb;
  v_matches integer;
  v_value app.workflow_execution_value_provenance%ROWTYPE;
  v_borrowed app.workflow_execution_value_provenance%ROWTYPE;
  v_snapshot jsonb;
BEGIN
  v_inspection:=app.inspect_native_coordinator_value_owner(p_owner);
  IF v_inspection->>'kind'='stopped' THEN RETURN v_inspection; END IF;
  v_inventory:=app.native_coordinator_value_inventory(p_owner);
  SELECT count(*)::integer INTO v_matches FROM (
    SELECT v_inventory->'runInput' descriptor WHERE v_inventory->'runInput'<>'null'::jsonb
    UNION ALL SELECT entry->'valueSource' FROM jsonb_array_elements(v_inventory->'outputs') entry
  ) descriptors WHERE descriptor=p_descriptor;
  IF v_matches<>1 THEN RAISE EXCEPTION 'native coordinator selected source identity differs' USING ERRCODE='23514'; END IF;
  SELECT * INTO v_value FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=(p_owner->>'workspaceId')::uuid AND source.id=(p_descriptor#>>'{source,provenanceId}')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'native coordinator selected provenance is unavailable' USING ERRCODE='55000'; END IF;
  IF v_value.byte_ownership='borrowed' THEN
    v_borrowed:=v_value;
    SELECT * INTO v_value FROM app.workflow_execution_value_provenance source
      WHERE source.workspace_id=v_borrowed.workspace_id AND source.id=v_borrowed.borrowed_from_provenance_id
        AND source.value_slot='attempt_input' AND source.byte_ownership='owned';
    IF NOT FOUND THEN RAISE EXCEPTION 'native coordinator borrowed source is unavailable' USING ERRCODE='55000'; END IF;
  END IF;
  IF v_value.eligibility_revoked_at IS NOT NULL OR v_value.eligible_until<=clock_timestamp()
    OR (v_borrowed.id IS NOT NULL AND (v_borrowed.eligibility_revoked_at IS NOT NULL OR v_borrowed.eligible_until<=clock_timestamp())) THEN
    RAISE EXCEPTION 'native coordinator selected source expired' USING ERRCODE='55000';
  END IF;
  v_snapshot:=jsonb_build_object('reference',v_value.original_reference,'sha256',v_value.sha256,'byteLength',v_value.byte_length);
  IF v_value.reference_kind='inline' THEN
    PERFORM app.assert_native_inline_execution_value_bytes(v_value.original_reference->'value',v_value.sha256,v_value.byte_length,v_value.original_inline_text);
    v_snapshot:=v_snapshot||jsonb_build_object('serializedValue',v_value.original_inline_text);
  END IF;
  IF v_value.eligible_until<=clock_timestamp() THEN
    RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','unavailable','reason','source_read_failed'));
  END IF;
  IF (v_inspection->>'deadlineAt')::timestamptz<=clock_timestamp() THEN
    RETURN jsonb_build_object('kind','stopped','stop',jsonb_build_object('kind','timed_out'));
  END IF;
  RETURN jsonb_build_object('kind','ready','valueSource',jsonb_build_object(
    'slot',p_descriptor->'slot','source',p_descriptor->'source','snapshot',v_snapshot));
END $$;
REVOKE ALL ON FUNCTION app.read_native_coordinator_value_source(jsonb,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.read_native_coordinator_value_source(jsonb,jsonb) TO {{worker_runtime_role}};

-- One selected source per read, under the ACTUAL existing attempt consumer.
-- Never fabricate a coordinator consumer or authorize by historical producer ID.
CREATE FUNCTION app.read_native_attempt_value_source(p_authority jsonb,p_selection jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_scope jsonb:=app.native_attempt_value_owner(p_authority);
  v_workspace uuid:=(v_scope->>'workspaceId')::uuid;
  v_run uuid:=(v_scope->>'runId')::uuid;
  v_version uuid:=(v_scope->>'workflowVersionId')::uuid;
  v_source app.workflow_execution_value_provenance%ROWTYPE;
  v_borrow app.workflow_execution_value_provenance%ROWTYPE;
  v_node app.node_runs%ROWTYPE;
  v_attempt app.node_attempts%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_invocation jsonb;
  v_matches integer;
  v_metadata jsonb;
  v_snapshot jsonb;
BEGIN
  IF (jsonb_typeof(p_selection)='object' AND (
    (p_selection=jsonb_build_object('slot','run_input')) OR
    (p_selection->>'slot'='upstream_output'
      AND p_selection ?& ARRAY['slot','nodeId','invocationKey']
      AND p_selection-ARRAY['slot','nodeId','invocationKey']='{}'::jsonb
      AND p_selection->>'nodeId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND octet_length(p_selection->>'invocationKey') BETWEEN 1 AND 256)
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'native attempt selected value scope is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT v_checkpoint FROM app.run_checkpoints checkpoint
    WHERE checkpoint.workspace_id=v_workspace AND checkpoint.workflow_run_id=v_run
      AND checkpoint.workflow_version_id=v_version;
  IF (v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb
    AND v_checkpoint.scheduler_state->'revision'=to_jsonb(v_checkpoint.revision)
    AND v_checkpoint.scheduler_state->>'workflowVersionId'=v_version::text
    AND v_checkpoint.scheduler_state->>'runStatus'='running') IS NOT TRUE THEN
    RAISE EXCEPTION 'native attempt current checkpoint differs' USING ERRCODE='55000';
  END IF;
  IF p_selection->>'slot'='run_input' THEN
    SELECT * INTO v_borrow FROM app.workflow_execution_value_provenance source
      WHERE source.workspace_id=v_workspace AND source.workflow_run_id=v_run
        AND source.workflow_version_id=v_version AND source.value_slot='run_input';
    IF NOT FOUND THEN
      IF EXISTS(SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
        AND run.id=v_run AND run.input_ref IS NULL AND run.trigger_type<>'workflow_call') THEN
        PERFORM app.native_attempt_value_owner(p_authority);
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'native attempt accepted run input is missing' USING ERRCODE='55000';
    END IF;
    IF v_borrow.byte_ownership='owned' THEN v_source:=v_borrow;
    ELSE
      SELECT source.* INTO v_source FROM app.workflow_execution_value_provenance source
        JOIN app.workflow_calls call ON call.workspace_id=v_workspace
          AND call.id=v_borrow.borrowed_workflow_call_id AND call.child_run_id=v_run
          AND call.child_workflow_version_id=v_version AND call.outcome_kind='admitted'
          AND call.sealed AND call.detail_retired_at IS NULL
          AND call.declaration_input_provenance_id=source.id
        WHERE source.workspace_id=v_workspace AND source.id=v_borrow.borrowed_from_provenance_id
          AND source.value_slot='attempt_input' AND source.byte_ownership='owned';
      IF NOT FOUND THEN RAISE EXCEPTION 'native attempt original borrowed input differs' USING ERRCODE='55000'; END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
      AND run.id=v_run AND run.input_ref::text=v_source.original_reference::text) THEN
      RAISE EXCEPTION 'native attempt first run input projection differs' USING ERRCODE='55000';
    END IF;
    v_metadata:=jsonb_build_object('kind','run_input','workspaceId',v_workspace,
      'runId',v_run,'workflowVersionId',v_version,'provenanceId',v_borrow.id);
  ELSE
    SELECT count(*)::integer,(jsonb_agg(invocation))->0 INTO v_matches,v_invocation
      FROM jsonb_array_elements(v_checkpoint.scheduler_state->'invocations') invocation
      WHERE invocation->>'nodeId'=p_selection->>'nodeId'
        AND invocation->>'invocationKey'=p_selection->>'invocationKey'
        AND invocation->>'status'='succeeded';
    IF v_matches<>1 THEN RAISE EXCEPTION 'native attempt selected invocation is not successful' USING ERRCODE='55000'; END IF;
    SELECT * INTO STRICT v_node FROM app.node_runs node WHERE node.workspace_id=v_workspace
      AND node.workflow_run_id=v_run AND node.node_id=p_selection->>'nodeId'
      AND node.invocation_key=p_selection->>'invocationKey' AND node.status='succeeded';
    SELECT * INTO STRICT v_attempt FROM app.node_attempts attempt WHERE attempt.workspace_id=v_workspace
      AND attempt.node_run_id=v_node.id AND attempt.id=v_node.current_attempt_id
      AND attempt.attempt_number=v_node.current_attempt_number AND attempt.status='succeeded';
    IF v_invocation#>>'{output,kind}'='workflow_call' THEN
      v_source:=app.native_workflow_call_result_provenance(v_run,v_node.invocation_key,
        (v_invocation#>>'{output,childRunId}')::uuid);
      SELECT * INTO STRICT v_call FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
        AND call.parent_run_id=v_run AND call.invocation_key=v_node.invocation_key
        AND call.child_run_id=v_source.workflow_run_id AND call.declaration_attempt_id=v_attempt.id
        AND call.detail_retired_at IS NULL;
      IF v_attempt.output_ref::text IS DISTINCT FROM v_node.input_ref::text THEN
        RAISE EXCEPTION 'native attempt Call physical alias differs' USING ERRCODE='55000';
      END IF;
      v_metadata:=jsonb_build_object('kind','workflow_call_result','workspaceId',v_workspace,
        'provenanceId',v_source.id,'parentRunId',v_run,'parentWorkflowVersionId',v_version,
        'childRunId',v_call.child_run_id,'childWorkflowVersionId',v_call.child_workflow_version_id,
        'nodeId',v_node.node_id,'invocationKey',v_node.invocation_key);
    ELSE
      SELECT * INTO STRICT v_source FROM app.workflow_execution_value_provenance source
        WHERE source.workspace_id=v_workspace AND source.workflow_run_id=v_run
          AND source.workflow_version_id=v_version AND source.value_slot='attempt_output'
          AND source.attempt_id=v_attempt.id AND source.attempt_number=v_attempt.attempt_number
          AND source.node_run_id=v_node.id AND source.node_id=v_node.node_id
          AND source.invocation_key=v_node.invocation_key AND source.byte_ownership='owned';
      IF v_invocation#>>'{output,kind}'<>'inline'
        OR v_invocation#>>'{output,attemptId}' IS DISTINCT FROM v_attempt.id::text
        OR v_attempt.output_ref::text IS DISTINCT FROM v_source.original_reference::text THEN
        RAISE EXCEPTION 'native attempt physical output identity differs' USING ERRCODE='55000';
      END IF;
      v_metadata:=jsonb_build_object('kind','physical_output','workspaceId',v_workspace,
        'provenanceId',v_source.id,'runId',v_run,'workflowVersionId',v_version,
        'nodeId',v_node.node_id,'invocationKey',v_node.invocation_key,'attemptId',v_attempt.id);
    END IF;
    IF v_node.output_ref::text IS DISTINCT FROM v_source.original_reference::text THEN
      RAISE EXCEPTION 'native attempt logical output projection differs' USING ERRCODE='55000';
    END IF;
  END IF;
  IF v_source.byte_ownership<>'owned' OR v_source.eligibility_revoked_at IS NOT NULL
    OR v_source.eligible_until<=clock_timestamp()
    OR (v_borrow.id IS NOT NULL AND (v_borrow.eligibility_revoked_at IS NOT NULL
      OR v_borrow.eligible_until<=clock_timestamp())) THEN
    RAISE EXCEPTION 'native attempt accepted source eligibility ended' USING ERRCODE='55000';
  END IF;
  -- Minimum inline owner only. Artifact locator authorization remains an open
  -- integration gate, not a fallback to artifact possession or decoded JSON.
  IF v_source.reference_kind<>'inline' THEN
    RAISE EXCEPTION 'native attempt artifact source authorization is unavailable' USING ERRCODE='55000';
  END IF;
  PERFORM app.assert_native_inline_execution_value_bytes(v_source.original_reference->'value',
    v_source.sha256,v_source.byte_length,v_source.original_inline_text);
  v_snapshot:=jsonb_build_object('reference',v_source.original_reference,
    'sha256',v_source.sha256,'byteLength',v_source.byte_length,'serializedValue',v_source.original_inline_text);
  PERFORM app.native_attempt_value_owner(p_authority);
  IF v_source.eligible_until<=clock_timestamp()
    OR (v_borrow.id IS NOT NULL AND v_borrow.eligible_until<=clock_timestamp()) THEN
    RAISE EXCEPTION 'native attempt source expired during read' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('slot',p_selection->'slot','source',v_metadata,'snapshot',v_snapshot);
END $$;
REVOKE ALL ON FUNCTION app.read_native_attempt_value_source(jsonb,jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.read_native_attempt_value_source(jsonb,jsonb) TO {{worker_runtime_role}};

CREATE FUNCTION app.guard_native_run_result_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_result app.workflow_execution_value_provenance%ROWTYPE;
BEGIN
  SELECT * INTO v_result FROM app.workflow_execution_value_provenance result WHERE result.workspace_id=OLD.workspace_id
    AND result.workflow_run_id=OLD.id AND result.workflow_version_id=OLD.workflow_version_id AND result.value_slot='run_result';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.output_ref::text IS NOT DISTINCT FROM v_result.original_reference::text THEN RETURN NEW; END IF;
  IF NEW.output_ref IS NULL AND v_result.eligibility_revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'accepted native run first result projection is immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.guard_native_run_result_projection()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE TRIGGER native_run_result_projection_immutable BEFORE UPDATE OF output_ref ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_native_run_result_projection();

-- Identifier-only parent wakeup in the EXISTING child terminal transaction.
-- Do not acquire parent/ancestor row locks behind the already-held child lock.
-- A failed result acceptance/deferred obligation rolls this outbox insert back.
CREATE FUNCTION app.wake_native_call_parent_on_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_call app.workflow_calls%ROWTYPE; v_event uuid:=gen_random_uuid(); v_payload text;
BEGIN
  SELECT * INTO v_call FROM app.workflow_calls call WHERE call.workspace_id=NEW.workspace_id AND call.child_run_id=NEW.id
    AND call.child_workflow_version_id=NEW.workflow_version_id AND call.callee_workflow_id=NEW.workflow_id
    AND call.outcome_kind='admitted' AND call.sealed;
  IF NOT FOUND THEN RAISE EXCEPTION 'native child terminal admitted journal differs' USING ERRCODE='23514'; END IF;
  IF v_call.detail_retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'native child terminal detail is retired' USING ERRCODE='55000';
  END IF;
  IF NEW.completed_at IS NULL OR NEW.workspace_id::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'native child terminal scope differs' USING ERRCODE='23514';
  END IF;
  v_payload:='{"outboxEventId":"'||v_event::text||'","runId":"'||v_call.parent_run_id::text
    ||'","schemaVersion":1,"workspaceId":"'||NEW.workspace_id::text||'"}';
  INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum)
    VALUES(v_event,NEW.workspace_id,'advance-workflow-run',1,'workflow-run',v_call.parent_run_id,
      v_payload::jsonb,encode(sha256(convert_to(v_payload,'UTF8')),'hex'));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.wake_native_call_parent_on_terminal()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE TRIGGER native_child_terminal_parent_wakeup AFTER UPDATE OF status ON app.workflow_runs
  FOR EACH ROW WHEN (NEW.trigger_type='workflow_call' AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown'))
  EXECUTE FUNCTION app.wake_native_call_parent_on_terminal();

CREATE FUNCTION app.check_native_terminal_result_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_result app.workflow_execution_value_provenance%ROWTYPE;
  v_run app.workflow_runs%ROWTYPE;
  v_checkpoint app.run_checkpoints%ROWTYPE;
  v_current uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.workflow_versions version WHERE version.workspace_id=NEW.workspace_id
    AND version.id=NEW.workflow_version_id AND version.workflow_id=NEW.workflow_id
    AND version.schema_version=2 AND version.executable_schema_version=3
    AND version.executable_json#>'{graph,callable,schemaVersion}'='1'::jsonb) THEN RETURN NULL; END IF;
  SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=NEW.workspace_id AND run.id=NEW.id;
  SELECT * INTO v_checkpoint FROM app.run_checkpoints checkpoint WHERE checkpoint.workspace_id=NEW.workspace_id
    AND checkpoint.workflow_run_id=NEW.id AND checkpoint.workflow_version_id=NEW.workflow_version_id;
  SELECT * INTO v_result FROM app.workflow_execution_value_provenance result WHERE result.workspace_id=NEW.workspace_id
    AND result.workflow_run_id=NEW.id AND result.workflow_version_id=NEW.workflow_version_id AND result.value_slot='run_result';
  IF NOT FOUND OR (v_run.status='succeeded' AND v_run.completed_at IS NOT NULL
    AND v_result.byte_ownership='owned' AND v_result.accepted_revision=v_checkpoint.revision
    AND v_checkpoint.scheduler_state->'schemaVersion'='3'::jsonb AND v_checkpoint.scheduler_state->>'runStatus'='succeeded'
    AND v_checkpoint.scheduler_state->'revision'=to_jsonb(v_checkpoint.revision)
    AND v_result.original_reference::text=v_run.output_ref::text
    AND v_result.eligibility_revoked_at IS NULL AND v_result.eligible_until>clock_timestamp()
    AND EXISTS(SELECT 1 FROM app.inbox_receipts receipt WHERE receipt.workspace_id=NEW.workspace_id
      AND receipt.consumer_name='workflow-coordinator' AND receipt.message_id=v_result.delivery_outbox_event_id
      AND receipt.payload_checksum=v_result.delivery_payload_checksum AND receipt.completed_at IS NOT NULL)) IS NOT TRUE THEN
    RAISE EXCEPTION 'native successful terminal result is incomplete at commit' USING ERRCODE='23514';
  END IF;
  FOREACH v_current IN ARRAY app.native_call_lineage(NEW.id) LOOP
    SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=NEW.workspace_id AND run.id=v_current;
    IF NOT FOUND OR (v_run.cancel_requested_at IS NULL AND isfinite(v_run.deadline_at) AND v_run.deadline_at>clock_timestamp()
      AND ((v_current=NEW.id AND v_run.status='succeeded')
        OR (v_current<>NEW.id AND v_run.status IN ('queued','running','waiting')))) IS NOT TRUE THEN
      RAISE EXCEPTION 'native terminal result family control changed before commit' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_native_terminal_result_commit()
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
CREATE CONSTRAINT TRIGGER native_terminal_result_complete AFTER UPDATE ON app.workflow_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='succeeded')
  EXECUTE FUNCTION app.check_native_terminal_result_commit();

-- Read-side Call facts are immutable journal plus actual child terminal truth.
-- No actor reauthorization, child UPDATE, transport-history pin or payload read
-- is performed here. Current consumer authorization belongs to the enclosing
-- actual coordinator/demand read owner, not these historical metadata labels.
CREATE FUNCTION app.read_workflow_call_facts(p_parent uuid)
RETURNS TABLE(fact jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_parent app.workflow_runs%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_child app.workflow_runs%ROWTYPE;
  v_call app.workflow_calls%ROWTYPE;
  v_source app.workflow_execution_value_provenance%ROWTYPE;
  v_pin jsonb;
  v_sites integer;
  v_count integer:=0;
BEGIN
  SELECT * INTO v_parent FROM app.workflow_runs run
    WHERE run.workspace_id=v_workspace AND run.id=p_parent;
  IF NOT FOUND THEN RAISE EXCEPTION 'native Call fact parent is unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_version FROM app.workflow_versions version
    WHERE version.workspace_id=v_workspace AND version.workflow_id=v_parent.workflow_id
      AND version.id=v_parent.workflow_version_id;
  IF NOT FOUND OR (v_version.schema_version=2 AND v_version.executable_schema_version=3
    AND jsonb_typeof(v_version.executable_json->'graph')='object') IS NOT TRUE THEN
    RAISE EXCEPTION 'native Call fact immutable version differs' USING ERRCODE='23514';
  END IF;
  FOR v_call IN SELECT call.* FROM app.workflow_calls call
    WHERE call.workspace_id=v_workspace AND call.parent_run_id=p_parent ORDER BY call.invocation_key
  LOOP
    IF v_call.detail_retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'native Call fact execution detail is retired' USING ERRCODE='55000';
    END IF;
    v_count:=v_count+1;
    IF v_count>64 OR NOT v_call.sealed OR v_call.parent_workflow_version_id<>v_parent.workflow_version_id THEN
      RAISE EXCEPTION 'native Call fact journal is incomplete' USING ERRCODE='23514';
    END IF;
    WITH RECURSIVE graphs(graph,depth) AS (
      SELECT v_version.executable_json->'graph',1 UNION ALL
      SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
        CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
        WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
    ), sites AS (SELECT node FROM graphs CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
      WHERE node->>'id'=v_call.node_id AND node#>>'{definition,key}'='core.workflow_call'
        AND node#>'{definition,version}'='1'::jsonb)
    SELECT count(*)::integer,(jsonb_agg(node->'config'))->0 INTO v_sites,v_pin FROM sites;
    IF v_sites<>1 OR (v_pin ?& ARRAY['workflowId','versionId','checksum','callableContractIdentity']
      AND v_pin-ARRAY['workflowId','versionId','checksum','callableContractIdentity']='{}'::jsonb
      AND v_pin->>'workflowId'=v_call.callee_workflow_id::text
      AND v_pin->>'versionId'=v_call.callee_workflow_version_id::text
      AND v_pin->>'callableContractIdentity' ~ '^callable:v1:sha256:[0-9a-f]{64}$'
      AND EXISTS(SELECT 1 FROM app.workflow_versions callee WHERE callee.workspace_id=v_workspace
        AND callee.workflow_id=v_call.callee_workflow_id AND callee.id=v_call.callee_workflow_version_id
        AND callee.schema_version=2 AND callee.executable_schema_version=3
        AND callee.checksum=v_pin->>'checksum')) IS NOT TRUE THEN
      RAISE EXCEPTION 'native Call fact immutable pin differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_source FROM app.workflow_execution_value_provenance source
      WHERE source.workspace_id=v_workspace AND source.id=v_call.declaration_input_provenance_id
        AND source.workflow_run_id=p_parent AND source.workflow_version_id=v_parent.workflow_version_id
        AND source.node_run_id=v_call.node_run_id AND source.node_id=v_call.node_id
        AND source.invocation_key=v_call.invocation_key AND source.attempt_id=v_call.declaration_attempt_id
        AND source.attempt_number=v_call.declaration_attempt_number
        AND source.value_slot='attempt_input' AND source.byte_ownership='owned';
    IF NOT FOUND THEN RAISE EXCEPTION 'native Call fact source identity differs' USING ERRCODE='23514'; END IF;
    fact:=jsonb_build_object('invocationKey',v_call.invocation_key,'nodeId',v_call.node_id,
      'declarationAttemptId',v_call.declaration_attempt_id,'pin',v_pin,'inputChecksum',v_source.sha256,
      'input',CASE WHEN v_source.reference_kind='inline' THEN
        jsonb_build_object('kind','inline','attemptId',v_call.declaration_attempt_id)
        ELSE jsonb_build_object('kind','artifact','artifactId',v_source.artifact_id) END);
    IF v_call.outcome_kind='admitted' THEN
      SELECT * INTO v_child FROM app.workflow_runs child WHERE child.workspace_id=v_workspace
        AND child.id=v_call.child_run_id AND child.workflow_id=v_call.callee_workflow_id
        AND child.workflow_version_id=v_call.child_workflow_version_id AND child.trigger_type='workflow_call';
      IF NOT FOUND THEN RAISE EXCEPTION 'native Call fact admitted child differs' USING ERRCODE='23514'; END IF;
      IF v_child.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown') THEN
        fact:=fact||jsonb_build_object('status','settled','childRunId',v_child.id,'childStatus',v_child.status);
      ELSIF v_child.status IN ('queued','running','waiting') THEN
        fact:=fact||jsonb_build_object('status','admitted','childRunId',v_child.id);
      ELSE RAISE EXCEPTION 'native Call fact child status differs' USING ERRCODE='23514'; END IF;
    ELSIF v_call.outcome_kind='refused' THEN
      fact:=fact||jsonb_build_object('status','refused','reasonCode',v_call.refusal_code);
    ELSIF v_call.outcome_kind='aborted' THEN
      fact:=fact||jsonb_build_object('status','aborted','reasonCode',
        CASE v_call.abort_reason WHEN 'cancel_requested' THEN 'workflow.canceled'
          WHEN 'deadline_expired' THEN 'workflow.timed_out' END);
    ELSE RAISE EXCEPTION 'native Call fact outcome differs' USING ERRCODE='23514'; END IF;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.read_workflow_call_facts(uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.read_workflow_call_facts(uuid) TO {{worker_runtime_role}};

GRANT EXECUTE ON FUNCTION app.prelock_workflow_call_parent(uuid,integer,jsonb,uuid,text),
  app.lock_workflow_call_admission(uuid,integer,text,uuid,uuid,text),
  app.reserve_workflow_call_active_admission(uuid,integer,text,uuid,uuid,uuid,text),
  app.record_workflow_call_outcome(uuid,integer,text,jsonb,uuid,text),
  app.seal_workflow_call_parent(uuid,integer,uuid,uuid,text) TO {{worker_runtime_role}};

-- Retention traverses immutable SUMMARY metadata, not execution/source authority.
-- Current consumer material read. Exact keys are selected by the bounded V3
-- graph owner; SQL independently derives the actual physical Call site/input.
CREATE FUNCTION app.read_workflow_call_declaration_materials(p_parent uuid,p_keys text[],p_consumer jsonb)
RETURNS TABLE(invocation_key text,node_id text,attempt_id uuid,callee_version_id uuid,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_control jsonb;
  v_run app.workflow_runs%ROWTYPE;
  v_version app.workflow_versions%ROWTYPE;
  v_callee app.workflow_versions%ROWTYPE;
  v_node app.node_runs%ROWTYPE;
  v_attempt app.node_attempts%ROWTYPE;
  v_input app.workflow_execution_value_provenance%ROWTYPE;
  v_key text;
  v_pin jsonb;
  v_sites integer;
BEGIN
  IF p_parent IS NULL OR p_keys IS NULL OR cardinality(p_keys)>64 OR
    cardinality(p_keys)<>(SELECT count(DISTINCT key) FROM unnest(p_keys) key) OR
    EXISTS(SELECT 1 FROM unnest(p_keys) key WHERE key IS NULL OR octet_length(key) NOT BETWEEN 1 AND 256) OR
    (p_consumer->>'runId'=p_parent::text AND p_consumer->>'workspaceId'=v_workspace::text) IS NOT TRUE THEN
    RAISE EXCEPTION 'native declaration consumer scope is invalid' USING ERRCODE='22023';
  END IF;
  v_control:=app.inspect_native_coordinator_value_owner(p_consumer);
  IF v_control->>'kind'<>'active' THEN
    RAISE EXCEPTION 'native declaration current consumer controls stopped' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=p_parent;
  SELECT * INTO v_version FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
    AND version.workflow_id=v_run.workflow_id AND version.id=v_run.workflow_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'native declaration immutable parent is missing' USING ERRCODE='55000'; END IF;
  FOREACH v_key IN ARRAY p_keys LOOP
    SELECT * INTO v_node FROM app.node_runs node WHERE node.workspace_id=v_workspace
      AND node.workflow_run_id=p_parent AND node.invocation_key=v_key;
    IF NOT FOUND OR v_node.current_attempt_id IS NULL THEN
      RAISE EXCEPTION 'native declaration physical node is missing' USING ERRCODE='55000';
    END IF;
    WITH RECURSIVE graphs(graph,depth) AS (
      SELECT v_version.executable_json->'graph',1 UNION ALL
      SELECT node->'structured'->'body',graphs.depth+1 FROM graphs
        CROSS JOIN LATERAL jsonb_array_elements(graphs.graph->'nodes') node
        WHERE graphs.depth<64 AND jsonb_typeof(node->'structured'->'body')='object'
    ), sites AS (SELECT node FROM graphs CROSS JOIN LATERAL jsonb_array_elements(graph->'nodes') node
      WHERE node->>'id'=v_node.node_id AND node#>>'{definition,key}'='core.workflow_call'
        AND node#>'{definition,version}'='1'::jsonb)
    SELECT count(*)::integer,(jsonb_agg(node->'config'))->0 INTO v_sites,v_pin FROM sites;
    IF v_sites<>1 OR (v_pin ?& ARRAY['workflowId','versionId','checksum','callableContractIdentity']
      AND v_pin-ARRAY['workflowId','versionId','checksum','callableContractIdentity']='{}'::jsonb) IS NOT TRUE THEN
      RAISE EXCEPTION 'native declaration immutable Call site differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_callee FROM app.workflow_versions version WHERE version.workspace_id=v_workspace
      AND version.workflow_id=(v_pin->>'workflowId')::uuid AND version.id=(v_pin->>'versionId')::uuid
      AND version.schema_version=2 AND version.executable_schema_version=3 AND version.checksum=v_pin->>'checksum';
    IF NOT FOUND THEN RAISE EXCEPTION 'native declaration pinned callee differs' USING ERRCODE='55000'; END IF;
    SELECT * INTO v_attempt FROM app.node_attempts attempt WHERE attempt.workspace_id=v_workspace
      AND attempt.id=v_node.current_attempt_id AND attempt.node_run_id=v_node.id;
    IF NOT FOUND OR (v_node.status='succeeded' AND v_node.side_effect_class='unsafe'
      AND v_node.current_attempt_number=1 AND v_attempt.attempt_number=1 AND v_attempt.status='succeeded'
      AND v_attempt.side_effect_class='unsafe' AND v_attempt.completed_at IS NOT NULL
      AND v_attempt.lease_owner IS NULL AND v_attempt.lease_expires_at IS NULL
      AND v_attempt.retry_decision IS NULL AND v_attempt.safe_error_code IS NULL
      AND v_attempt.executor_failure_kind IS NULL AND v_attempt.executor_error_kind IS NULL
      AND v_attempt.executor_possibly_dispatched IS NULL) IS NOT TRUE THEN
      RAISE EXCEPTION 'native declaration physical success differs' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_input FROM app.workflow_execution_value_provenance source
      WHERE source.workspace_id=v_workspace AND source.workflow_run_id=p_parent
        AND source.workflow_version_id=v_run.workflow_version_id AND source.node_run_id=v_node.id
        AND source.node_id=v_node.node_id AND source.invocation_key=v_key AND source.attempt_id=v_attempt.id
        AND source.attempt_number=1 AND source.value_slot='attempt_input' AND source.byte_ownership='owned';
    IF NOT FOUND OR (v_input.reference_kind='inline' AND v_input.eligibility_revoked_at IS NULL
      AND v_input.eligible_until>clock_timestamp() AND v_node.input_ref::text=v_input.original_reference::text
      AND v_attempt.output_ref::text=v_input.original_reference::text) IS NOT TRUE THEN
      RAISE EXCEPTION 'native declaration FIRST input is unavailable' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM app.run_events event WHERE event.workspace_id=v_workspace
      AND event.workflow_run_id=p_parent AND event.type='node.succeeded'
      AND event.payload->>'attemptId'=v_attempt.id::text AND event.payload->>'nodeRunId'=v_node.id::text
      AND event.payload->>'nodeId'=v_node.node_id AND event.payload->>'invocationKey'=v_key
      AND event.payload->'attemptNumber'='1'::jsonb) THEN
      RAISE EXCEPTION 'native declaration physical success fact is missing' USING ERRCODE='23514';
    END IF;
    PERFORM app.assert_native_inline_execution_value_bytes(v_input.original_reference->'value',
      v_input.sha256,v_input.byte_length,v_input.original_inline_text);
    PERFORM app.assert_native_callable_value(v_callee.executable_json#>'{graph,callable,input}',v_input.original_reference->'value');
    IF v_input.eligible_until<=clock_timestamp() OR
      app.inspect_native_coordinator_value_owner(p_consumer)->>'kind'<>'active' THEN
      RAISE EXCEPTION 'native declaration source/control expired during read' USING ERRCODE='55000';
    END IF;
    invocation_key:=v_key;node_id:=v_node.node_id;attempt_id:=v_attempt.id;callee_version_id:=v_callee.id;
    snapshot:=jsonb_build_object('reference',v_input.original_reference,'sha256',v_input.sha256,
      'byteLength',v_input.byte_length,'serializedValue',v_input.original_inline_text);
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.read_workflow_call_declaration_materials(uuid,text[],jsonb)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}};
GRANT EXECUTE ON FUNCTION app.read_workflow_call_declaration_materials(uuid,text[],jsonb) TO {{worker_runtime_role}};

-- Retention traverses immutable SUMMARY metadata, not execution/source authority.
-- The complete journal set remains intact through all resumable detail pages.
CREATE FUNCTION app.native_retention_family_runs(p_run uuid) RETURNS uuid[]
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_root uuid;
  v_roots uuid[];
  v_runs uuid[];
  v_call record;
  v_count integer:=0;
BEGIN
  IF v_workspace IS NULL OR p_run IS NULL THEN
    RAISE EXCEPTION 'native retention family scope is invalid' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(root_run_id) INTO v_roots FROM (
    SELECT DISTINCT call.root_run_id FROM app.workflow_calls call
      WHERE call.workspace_id=v_workspace AND
        (call.parent_run_id=p_run OR call.child_run_id=p_run OR call.root_run_id=p_run)
      LIMIT 2
  ) roots;
  IF cardinality(v_roots)>1 THEN
    RAISE EXCEPTION 'native retention family is ambiguous' USING ERRCODE='55000';
  END IF;
  v_root:=coalesce(v_roots[1],p_run);
  IF NOT EXISTS (SELECT 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
      AND run.id=v_root AND run.trigger_type<>'workflow_call') THEN
    RAISE EXCEPTION 'native retention family root is missing' USING ERRCODE='55000';
  END IF;
  v_runs:=ARRAY[v_root];
  FOR v_call IN SELECT call.id,call.parent_run_id,call.child_run_id,call.call_depth,
      call.parent_workflow_version_id,call.child_workflow_version_id,call.outcome_kind,call.sealed
    FROM app.workflow_calls call WHERE call.workspace_id=v_workspace AND call.root_run_id=v_root
    ORDER BY call.id LIMIT 65
  LOOP
    v_count:=v_count+1;
    IF v_count>64 OR NOT v_call.sealed OR
      (v_call.parent_run_id=v_root AND v_call.call_depth<>1) OR
      (v_call.parent_run_id<>v_root AND NOT EXISTS (
        SELECT 1 FROM app.workflow_calls parent WHERE parent.workspace_id=v_workspace
          AND parent.root_run_id=v_root AND parent.child_run_id=v_call.parent_run_id
          AND parent.outcome_kind='admitted' AND parent.sealed
          AND parent.call_depth=v_call.call_depth-1
          AND parent.child_workflow_version_id=v_call.parent_workflow_version_id
      )) OR NOT EXISTS (SELECT 1 FROM app.workflow_runs parent WHERE parent.workspace_id=v_workspace
        AND parent.id=v_call.parent_run_id AND parent.workflow_version_id=v_call.parent_workflow_version_id) OR
      (v_call.outcome_kind='admitted' AND NOT EXISTS (SELECT 1 FROM app.workflow_runs child
        WHERE child.workspace_id=v_workspace AND child.id=v_call.child_run_id
          AND child.workflow_version_id=v_call.child_workflow_version_id AND child.trigger_type='workflow_call')) THEN
      RAISE EXCEPTION 'native retention family is incomplete' USING ERRCODE='55000';
    END IF;
    v_runs:=array_append(v_runs,v_call.parent_run_id);
    IF v_call.child_run_id IS NOT NULL THEN v_runs:=array_append(v_runs,v_call.child_run_id); END IF;
  END LOOP;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_runs FROM unnest(v_runs) id;
  IF cardinality(v_runs)>65 OR NOT p_run=ANY(v_runs) OR EXISTS (
    SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
      AND call.parent_run_id=ANY(v_runs) AND call.root_run_id<>v_root
  ) THEN RAISE EXCEPTION 'native retention family membership differs' USING ERRCODE='55000'; END IF;
  RETURN v_runs;
END $$;
REVOKE ALL ON FUNCTION app.native_retention_family_runs(uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

CREATE FUNCTION app.native_retention_family_eligible(p_run uuid,p_cutoff timestamptz,p_summary boolean)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_runs uuid[];
  v_native boolean;
  v_run record;
  v_count integer:=0;
BEGIN
  IF p_cutoff IS NULL OR NOT isfinite(p_cutoff) OR p_summary IS NULL THEN
    RAISE EXCEPTION 'native retention cutoff is invalid' USING ERRCODE='22023';
  END IF;
  SELECT version.schema_version=2 AND version.executable_schema_version=3 INTO v_native
    FROM app.workflow_runs run JOIN app.workflow_versions version
      ON version.workspace_id=run.workspace_id AND version.id=run.workflow_version_id
    WHERE run.workspace_id=v_workspace AND run.id=p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'native retention run version is missing' USING ERRCODE='55000'; END IF;
  -- Retained-only detail pages preserve their existing eligibility behavior.
  IF NOT coalesce(v_native,false) THEN RETURN true; END IF;
  v_runs:=app.native_retention_family_runs(p_run);
  FOR v_run IN SELECT run.id,run.status,run.completed_at,run.details_purged_at
    FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=ANY(v_runs)
    ORDER BY run.id
  LOOP
    v_count:=v_count+1;
    IF v_run.status NOT IN ('succeeded','failed','canceled','timed_out','outcome_unknown')
      OR v_run.completed_at IS NULL OR NOT isfinite(v_run.completed_at)
      OR v_run.completed_at>p_cutoff-(CASE WHEN p_summary THEN interval '90 days' ELSE interval '30 days' END)
      OR (p_summary AND v_run.details_purged_at IS NULL) THEN RETURN false; END IF;
  END LOOP;
  IF v_count<>cardinality(v_runs) THEN
    RAISE EXCEPTION 'native retention family run is missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=v_workspace AND source.workflow_run_id=ANY(v_runs)
      AND source.eligible_until>p_cutoff) THEN RETURN false; END IF;
  -- Reuse the existing indexed DIRECT replay summary dependency. Its eventual
  -- existing teardown permits this finite policy-driven extension; timestamps
  -- alone never authorize clearing a still-retained replay relationship.
  IF EXISTS (SELECT 1 FROM app.workflow_runs replay WHERE replay.workspace_id=v_workspace
      AND replay.replay_source_run_id=ANY(v_runs)) OR
    EXISTS (SELECT 1 FROM app.operator_run_replay_requests request WHERE request.workspace_id=v_workspace
      AND request.source_run_id=ANY(v_runs) AND request.status='pending') THEN RETURN false; END IF;
  IF p_summary AND (
    EXISTS (SELECT 1 FROM app.webhook_trigger_deliveries delivery WHERE delivery.workspace_id=v_workspace
      AND delivery.workflow_run_id=ANY(v_runs)) OR
    EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay WHERE replay.workspace_id=v_workspace
      AND replay.workflow_run_id=ANY(v_runs)) OR
    EXISTS (SELECT 1 FROM app.trigger_schedule_occurrences occurrence WHERE occurrence.workspace_id=v_workspace
      AND occurrence.workflow_run_id=ANY(v_runs)) OR
    EXISTS (SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=v_workspace
      AND call.parent_run_id=ANY(v_runs) AND call.detail_retired_at IS NULL)
  ) THEN RETURN false; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.native_retention_family_eligible(uuid,timestamptz,boolean)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

CREATE INDEX native_value_borrowed_retention_idx
  ON app.workflow_execution_value_provenance(workspace_id,eligible_until,id) WHERE byte_ownership='borrowed';
CREATE INDEX native_value_owned_retention_idx
  ON app.workflow_execution_value_provenance(workspace_id,eligible_until,id) WHERE byte_ownership='owned';
CREATE INDEX native_value_candidate_retention_idx
  ON app.workflow_execution_value_artifact_candidates(workspace_id,workflow_run_id,id);
CREATE INDEX native_pending_replay_retention_idx
  ON app.operator_run_replay_requests(workspace_id,source_run_id) WHERE status='pending';

-- Private extension of the EXISTING actual lease/high-water/hold owner. No
-- runtime/maintenance caller receives a new destructive function grant.
CREATE FUNCTION app.execute_native_execution_detail_page(
  p_batch uuid,p_token uuid,p_fence bigint,p_limit integer,p_sequence bigint,p_hash char(64)
) RETURNS integer LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_batch app.retention_batches%ROWTYPE;
  v_count integer:=0;
  v_page uuid[];
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'native detail page limit is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches batch WHERE batch.id=p_batch FOR UPDATE;
  IF NOT FOUND OR (v_batch.workspace_id=v_workspace AND v_batch.status='running' AND NOT v_batch.dry_run
    AND v_batch.retention_kind='execution_detail' AND v_batch.retention_stage='attempts'
    AND v_batch.lease_token=p_token AND v_batch.lease_fence=p_fence
    AND v_batch.lease_expires_at>clock_timestamp()) IS NOT TRUE THEN
    RAISE EXCEPTION 'native detail actual retention lease differs' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace
    AND workspace.retention_control_sequence=p_sequence AND workspace.retention_control_hash=p_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native detail retention high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold WHERE hold.workspace_id=v_workspace
    AND hold.released_at IS NULL) THEN
    RAISE EXCEPTION 'native detail legal hold is active' USING ERRCODE='55000';
  END IF;

  SELECT array_agg(id) INTO v_page FROM (SELECT source.id FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=v_workspace AND source.byte_ownership='borrowed' AND source.eligible_until<=v_batch.cutoff_at
      AND app.native_retention_family_eligible(source.workflow_run_id,v_batch.cutoff_at,false)
    ORDER BY source.eligible_until,source.id LIMIT p_limit FOR UPDATE) page;
  -- Distinct statements: never UPDATE and DELETE the same provenance row in
  -- sibling modifying CTEs, whose same-row ordering is not defined.
  UPDATE app.workflow_execution_value_provenance source
    SET eligibility_revoked_at=coalesce(source.eligibility_revoked_at,clock_timestamp())
    WHERE source.workspace_id=v_workspace AND source.id=ANY(v_page);
  UPDATE app.workflow_runs run SET input_ref=NULL,input_ref_expires_at=NULL,updated_at=clock_timestamp()
    WHERE run.workspace_id=v_workspace AND run.id IN (SELECT source.workflow_run_id
      FROM app.workflow_execution_value_provenance source WHERE source.workspace_id=v_workspace AND source.id=ANY(v_page));
  DELETE FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=v_workspace AND source.id=ANY(v_page);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    IF v_batch.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'native detail retention lease expired' USING ERRCODE='55000'; END IF;
    RETURN v_count;
  END IF;

  WITH page AS MATERIALIZED (SELECT association.provenance_id FROM app.workflow_execution_value_artifact_associations association
    JOIN app.workflow_execution_value_provenance source ON source.workspace_id=association.workspace_id AND source.id=association.provenance_id
    WHERE association.workspace_id=v_workspace AND source.eligible_until<=v_batch.cutoff_at
      AND app.native_retention_family_eligible(source.workflow_run_id,v_batch.cutoff_at,false)
    ORDER BY association.provenance_id LIMIT p_limit FOR UPDATE OF association
  ) DELETE FROM app.workflow_execution_value_artifact_associations association USING page
    WHERE association.workspace_id=v_workspace AND association.provenance_id=page.provenance_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    IF v_batch.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'native detail retention lease expired' USING ERRCODE='55000'; END IF;
    RETURN v_count;
  END IF;

  WITH page AS MATERIALIZED (SELECT call.id FROM app.workflow_calls call
    WHERE call.workspace_id=v_workspace AND call.detail_retired_at IS NULL
      AND app.native_retention_family_eligible(call.parent_run_id,v_batch.cutoff_at,false)
      AND NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_provenance borrowed
        WHERE borrowed.workspace_id=v_workspace AND borrowed.borrowed_workflow_call_id=call.id)
    ORDER BY call.id LIMIT p_limit FOR UPDATE
  ) UPDATE app.workflow_calls call SET node_run_id=NULL,declaration_attempt_id=NULL,
      declaration_input_provenance_id=NULL,detail_retired_at=clock_timestamp()
    FROM page WHERE call.workspace_id=v_workspace AND call.id=page.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    IF v_batch.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'native detail retention lease expired' USING ERRCODE='55000'; END IF;
    RETURN v_count;
  END IF;

  SELECT array_agg(id) INTO v_page FROM (SELECT source.id
    FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=v_workspace AND source.byte_ownership='owned' AND source.eligible_until<=v_batch.cutoff_at
      AND app.native_retention_family_eligible(source.workflow_run_id,v_batch.cutoff_at,false)
      AND NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_provenance borrowed
        WHERE borrowed.workspace_id=v_workspace AND borrowed.borrowed_from_provenance_id=source.id)
      AND NOT EXISTS(SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=v_workspace AND call.declaration_input_provenance_id=source.id)
      AND NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_artifact_associations association
        WHERE association.workspace_id=v_workspace AND association.provenance_id=source.id)
    ORDER BY source.eligible_until,source.id LIMIT p_limit FOR UPDATE) page;
  UPDATE app.workflow_execution_value_provenance source
    SET eligibility_revoked_at=coalesce(source.eligibility_revoked_at,clock_timestamp())
    WHERE source.workspace_id=v_workspace AND source.id=ANY(v_page);
  UPDATE app.workflow_runs run SET input_ref=NULL,input_ref_expires_at=NULL,updated_at=clock_timestamp()
    WHERE run.workspace_id=v_workspace AND run.id IN (SELECT source.workflow_run_id
      FROM app.workflow_execution_value_provenance source WHERE source.workspace_id=v_workspace
        AND source.id=ANY(v_page) AND source.value_slot='run_input');
  UPDATE app.workflow_runs run SET output_ref=NULL,updated_at=clock_timestamp()
    WHERE run.workspace_id=v_workspace AND run.id IN (SELECT source.workflow_run_id
      FROM app.workflow_execution_value_provenance source WHERE source.workspace_id=v_workspace
        AND source.id=ANY(v_page) AND source.value_slot='run_result');
  DELETE FROM app.workflow_execution_value_provenance source
    WHERE source.workspace_id=v_workspace AND source.id=ANY(v_page);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    IF v_batch.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'native detail retention lease expired' USING ERRCODE='55000'; END IF;
    RETURN v_count;
  END IF;

  WITH page AS MATERIALIZED (SELECT candidate.id FROM app.workflow_execution_value_artifact_candidates candidate
    WHERE candidate.workspace_id=v_workspace AND candidate.created_at<=v_batch.cutoff_at-interval '30 days'
      AND app.native_retention_family_eligible(candidate.workflow_run_id,v_batch.cutoff_at,false)
      AND NOT EXISTS(SELECT 1 FROM app.workflow_execution_value_artifact_associations association
        WHERE association.workspace_id=v_workspace AND association.candidate_id=candidate.id)
    ORDER BY candidate.id LIMIT p_limit FOR UPDATE
  ) DELETE FROM app.workflow_execution_value_artifact_candidates candidate USING page
    WHERE candidate.workspace_id=v_workspace AND candidate.id=page.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_batch.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'native detail retention lease expired' USING ERRCODE='55000'; END IF;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION app.execute_native_execution_detail_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

CREATE INDEX workflow_runs_native_summary_retention_idx
  ON app.workflow_runs(workspace_id,completed_at,id)
  WHERE native_initiating_actor_id IS NOT NULL AND details_purged_at IS NOT NULL;

-- Native-only exception: select ONE family unit, never p_limit * 65 rows.
-- Ordinary per-run summary work is a separate branch in the existing owner.
CREATE FUNCTION app.execute_native_family_summary_page(
  p_batch uuid,p_token uuid,p_fence bigint,p_limit integer,p_sequence bigint,p_hash char(64)
) RETURNS integer LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
  v_batch app.retention_batches%ROWTYPE;
  v_root uuid;
  v_runs uuid[];
  v_calls uuid[];
  v_run_count integer;
  v_call_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'native summary family page limit is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches batch WHERE batch.id=p_batch FOR UPDATE;
  IF NOT FOUND OR (v_batch.workspace_id=v_workspace AND v_batch.status='running' AND NOT v_batch.dry_run
    AND v_batch.retention_kind='run_summary' AND v_batch.lease_token=p_token AND v_batch.lease_fence=p_fence
    AND v_batch.lease_expires_at>clock_timestamp()) IS NOT TRUE THEN
    RAISE EXCEPTION 'native summary actual retention lease differs' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace
    AND workspace.retention_control_sequence=p_sequence AND workspace.retention_control_hash=p_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'native summary retention high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds hold WHERE hold.workspace_id=v_workspace AND hold.released_at IS NULL) THEN
    RAISE EXCEPTION 'native summary legal hold is active' USING ERRCODE='55000';
  END IF;
  SELECT run.id INTO v_root FROM app.workflow_runs run WHERE run.workspace_id=v_workspace
    AND run.native_initiating_actor_id IS NOT NULL AND run.details_purged_at IS NOT NULL
    AND run.completed_at<=v_batch.cutoff_at-interval '90 days'
    AND EXISTS(SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=v_workspace AND call.root_run_id=run.id)
    AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,true)
    ORDER BY run.completed_at,run.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_runs:=app.native_retention_family_runs(v_root);
  -- Workspace UPDATE serializes membership/control changes; nevertheless lock
  -- and rederive the complete stable set before either delete statement.
  PERFORM 1 FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=ANY(v_runs)
    ORDER BY run.id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO v_calls FROM (SELECT call.id FROM app.workflow_calls call
    WHERE call.workspace_id=v_workspace AND call.root_run_id=v_root ORDER BY call.id LIMIT 65 FOR UPDATE) locked;
  IF cardinality(v_runs)>65 OR cardinality(v_calls)>64 OR
    app.native_retention_family_runs(v_root) IS DISTINCT FROM v_runs OR
    NOT app.native_retention_family_eligible(v_root,v_batch.cutoff_at,true) OR
    EXISTS(SELECT 1 FROM app.workflow_execution_value_provenance source
      WHERE source.workspace_id=v_workspace AND source.workflow_run_id=ANY(v_runs)) OR
    EXISTS(SELECT 1 FROM app.workflow_execution_value_artifact_candidates candidate
      WHERE candidate.workspace_id=v_workspace AND candidate.workflow_run_id=ANY(v_runs)) THEN
    RAISE EXCEPTION 'native summary stable family detail differs' USING ERRCODE='55000';
  END IF;
  DELETE FROM app.workflow_calls call WHERE call.workspace_id=v_workspace AND call.id=ANY(v_calls);
  GET DIAGNOSTICS v_call_count=ROW_COUNT;
  DELETE FROM app.workflow_runs run WHERE run.workspace_id=v_workspace AND run.id=ANY(v_runs);
  GET DIAGNOSTICS v_run_count=ROW_COUNT;
  IF v_call_count<>cardinality(v_calls) OR v_run_count<>cardinality(v_runs)
    OR v_batch.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'native summary atomic teardown changed or lease expired' USING ERRCODE='55000';
  END IF;
  -- Existing counters report physical run rows, not a misleading value of one.
  -- Existing audit reports the separately bounded family/journal units.
  INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
    VALUES(gen_random_uuid(),v_workspace,'retention.native_family_completed','retention-batch',p_batch,
      jsonb_build_object('familyUnits',1,'physicalRunRows',v_run_count,'journalRows',v_call_count,
        'maximumFamilyUnits',1,'maximumRunRows',65,'maximumJournalRows',64));
  RETURN v_run_count;
END $$;
REVOKE ALL ON FUNCTION app.execute_native_family_summary_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};

-- Exact current registered owner bodies through migration 0136; no stale
-- function replacement, role/grant widening, or executable qualification.
DO $native_retention_owner_drift$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.execute_standard_retention_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure) IS DISTINCT FROM '898144916026cbbbe455cc5496354892' THEN
    RAISE EXCEPTION 'native retention registered owner body drifted' USING ERRCODE='55000';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.standard_retention_dry_run_stage_keys(uuid,character varying,character varying,timestamptz,jsonb,jsonb,boolean,integer)'::regprocedure) IS DISTINCT FROM '1e1baa80550dbcbcb3f4eab4f1137051' THEN
    RAISE EXCEPTION 'native retention registered owner body drifted' USING ERRCODE='55000';
  END IF;
END $native_retention_owner_drift$;

-- Complete final registered retention body: ordinary rows retain per-run
-- bounds; native summary branch selects one atomic capped family.
CREATE OR REPLACE FUNCTION app.execute_standard_retention_page(
  p_batch_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_limit integer,
  p_expected_control_sequence bigint,p_expected_control_hash char(64)
) RETURNS TABLE(outcome varchar,examined_delta integer,eligible_delta integer,
  cursor_expires_at timestamptz,cursor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_batch app.retention_batches%ROWTYPE;
  v_count integer:=0;
  v_next_stage varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_page_limit IS NULL OR p_page_limit NOT BETWEEN 1 AND 1000
    OR p_expected_control_sequence IS NULL OR p_expected_control_sequence<0
    OR p_expected_control_hash IS NULL OR p_expected_control_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid standard retention page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR v_batch.dry_run
    OR v_batch.retention_kind NOT IN ('execution_detail','run_summary',
      'trigger_summary','audit_security')
    OR v_batch.lease_token<>p_lease_token OR v_batch.lease_fence<>p_lease_fence
    OR v_batch.lease_expires_at<=clock_timestamp() THEN
    RETURN QUERY SELECT 'stale'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;
  PERFORM set_config('app.workspace_id',v_batch.workspace_id::text,true);
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_batch.workspace_id
    AND workspace.retention_control_sequence=p_expected_control_sequence
    AND workspace.retention_control_hash=p_expected_control_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention control high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_batch.workspace_id AND hold.released_at IS NULL) THEN
    PERFORM set_config('app.retention_batch_transition','on',true);
    UPDATE app.retention_batches SET status='paused',pause_reason='legal_hold',
      paused_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,
      lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=p_batch_id;
    RETURN QUERY SELECT 'paused'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;

  IF v_batch.retention_kind='execution_detail' THEN
    IF v_batch.retention_stage='attempts' THEN
      v_count:=app.execute_native_execution_detail_page(p_batch_id,p_lease_token,p_lease_fence,
        p_page_limit,p_expected_control_sequence,p_expected_control_hash);
      IF v_count=0 THEN
      WITH candidates AS MATERIALIZED (SELECT attempt.id FROM app.node_attempts attempt
        JOIN app.node_runs node ON node.id=attempt.node_run_id
        JOIN app.workflow_runs run ON run.id=node.workflow_run_id
        WHERE attempt.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
          AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,false)
        ORDER BY attempt.id LIMIT p_page_limit), cleared AS (
        UPDATE app.node_runs node SET current_attempt_id=NULL,current_attempt_number=NULL,
          updated_at=clock_timestamp() WHERE node.current_attempt_id IN (SELECT id FROM candidates)
      ), removed AS (DELETE FROM app.node_attempts WHERE id IN (SELECT id FROM candidates)
        RETURNING id) SELECT count(*)::integer INTO v_count FROM removed;
      END IF;
      v_next_stage:='node_runs';
    ELSIF v_batch.retention_stage='node_runs' THEN
      WITH candidates AS MATERIALIZED (SELECT node.id FROM app.node_runs node
        JOIN app.workflow_runs run ON run.id=node.workflow_run_id
        WHERE node.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
          AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,false)
        ORDER BY node.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.node_runs WHERE id IN (SELECT id FROM candidates) RETURNING id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='events';
    ELSIF v_batch.retention_stage='events' THEN
      WITH candidates AS MATERIALIZED (SELECT event.workflow_run_id,event.sequence
        FROM app.run_events event JOIN app.workflow_runs run ON run.id=event.workflow_run_id
        WHERE event.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
          AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,false)
        ORDER BY event.workflow_run_id,event.sequence LIMIT p_page_limit), removed AS (
        DELETE FROM app.run_events event USING candidates
        WHERE event.workflow_run_id=candidates.workflow_run_id
          AND event.sequence=candidates.sequence RETURNING event.sequence)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='checkpoints';
    ELSIF v_batch.retention_stage='checkpoints' THEN
      WITH candidates AS MATERIALIZED (SELECT checkpoint.workflow_run_id
        FROM app.run_checkpoints checkpoint JOIN app.workflow_runs run
          ON run.id=checkpoint.workflow_run_id
        WHERE checkpoint.workspace_id=v_batch.workspace_id
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
          AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,false)
        ORDER BY checkpoint.workflow_run_id LIMIT p_page_limit), removed AS (
        DELETE FROM app.run_checkpoints checkpoint USING candidates
        WHERE checkpoint.workflow_run_id=candidates.workflow_run_id
        RETURNING checkpoint.workflow_run_id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='summaries';
    ELSE
      WITH candidates AS MATERIALIZED (SELECT run.id FROM app.workflow_runs run
        WHERE run.workspace_id=v_batch.workspace_id AND run.details_purged_at IS NULL
          AND run.completed_at<=v_batch.cutoff_at-interval '30 days'
          AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,false)
        ORDER BY run.completed_at,run.id LIMIT p_page_limit), changed AS (
        UPDATE app.workflow_runs run SET output_ref=NULL,error_summary=NULL,
          cancel_reason=NULL,details_purged_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM candidates WHERE run.id=candidates.id RETURNING run.id)
        SELECT count(*)::integer INTO v_count FROM changed;
      v_next_stage:=NULL;
    END IF;
  ELSIF v_batch.retention_kind='trigger_summary' THEN
    IF v_batch.retention_stage='replay' THEN
      WITH candidates AS MATERIALIZED (SELECT replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash
        FROM app.webhook_trigger_replay_records replay
        WHERE replay.workspace_id=v_batch.workspace_id AND replay.expires_at<=v_batch.cutoff_at
        ORDER BY replay.expires_at,replay.endpoint_id LIMIT p_page_limit), removed AS (
        DELETE FROM app.webhook_trigger_replay_records replay USING candidates
        WHERE replay.endpoint_id=candidates.endpoint_id AND replay.dedupe_kind=candidates.dedupe_kind
          AND replay.dedupe_key_hash=candidates.dedupe_key_hash RETURNING replay.endpoint_id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='deliveries';
    ELSIF v_batch.retention_stage='deliveries' THEN
      WITH candidates AS MATERIALIZED (SELECT delivery.id FROM app.webhook_trigger_deliveries delivery
        WHERE delivery.workspace_id=v_batch.workspace_id AND delivery.expires_at<=v_batch.cutoff_at
          AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay
            WHERE replay.workspace_id=delivery.workspace_id AND replay.delivery_id=delivery.id)
        ORDER BY delivery.expires_at,delivery.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.webhook_trigger_deliveries delivery USING candidates
        WHERE delivery.id=candidates.id RETURNING delivery.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='occurrences';
    ELSE
      WITH candidates AS MATERIALIZED (SELECT occurrence.id FROM app.trigger_schedule_occurrences occurrence
        WHERE occurrence.workspace_id=v_batch.workspace_id
          AND occurrence.scheduled_at<=v_batch.cutoff_at-interval '90 days'
        ORDER BY occurrence.scheduled_at,occurrence.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.trigger_schedule_occurrences occurrence USING candidates
        WHERE occurrence.id=candidates.id RETURNING occurrence.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:=NULL;
    END IF;
  ELSIF v_batch.retention_kind='run_summary' THEN
    v_count:=app.execute_native_family_summary_page(p_batch_id,p_lease_token,p_lease_fence,
      p_page_limit,p_expected_control_sequence,p_expected_control_hash);
    IF v_count=0 THEN
    WITH candidates AS MATERIALIZED (SELECT run.id FROM app.workflow_runs run
      WHERE run.workspace_id=v_batch.workspace_id
        AND run.completed_at<=v_batch.cutoff_at-interval '90 days'
        AND app.native_retention_family_eligible(run.id,v_batch.cutoff_at,true)
        AND NOT EXISTS(SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=v_batch.workspace_id
          AND (call.root_run_id=run.id OR call.parent_run_id=run.id OR call.child_run_id=run.id))
        AND run.details_purged_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM app.workflow_runs child
          WHERE child.workspace_id=run.workspace_id
            AND child.replay_source_run_id=run.id)
        AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_deliveries delivery
          WHERE delivery.workspace_id=run.workspace_id AND delivery.workflow_run_id=run.id)
        AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay
          WHERE replay.workspace_id=run.workspace_id AND replay.workflow_run_id=run.id)
        AND NOT EXISTS (SELECT 1 FROM app.trigger_schedule_occurrences occurrence
          WHERE occurrence.workspace_id=run.workspace_id AND occurrence.workflow_run_id=run.id)
      ORDER BY run.completed_at,run.id LIMIT p_page_limit), removed AS (
      DELETE FROM app.workflow_runs run USING candidates WHERE run.id=candidates.id RETURNING run.id)
      SELECT count(*)::integer INTO v_count FROM removed;
    END IF;
    v_next_stage:=NULL;
  ELSE
    IF v_batch.retention_stage='audit' THEN
      WITH candidates AS MATERIALIZED (SELECT audit.id FROM app.audit_events audit
        WHERE audit.workspace_id=v_batch.workspace_id
          AND audit.occurred_at<=v_batch.cutoff_at-interval '365 days'
        ORDER BY audit.occurred_at,audit.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.audit_events audit USING candidates WHERE audit.id=candidates.id RETURNING audit.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:='transport';
    ELSE
      WITH candidates AS MATERIALIZED (SELECT fact.id FROM app.transport_security_audit_facts fact
        WHERE fact.workspace_id=v_batch.workspace_id
          AND fact.occurred_at<=v_batch.cutoff_at-interval '365 days'
        ORDER BY fact.occurred_at,fact.id LIMIT p_page_limit), removed AS (
        DELETE FROM app.transport_security_audit_facts fact USING candidates
        WHERE fact.id=candidates.id RETURNING fact.id)
        SELECT count(*)::integer INTO v_count FROM removed;
      v_next_stage:=NULL;
    END IF;
  END IF;

  PERFORM set_config('app.retention_batch_transition','on',true);
  IF v_count=0 AND v_next_stage IS NULL THEN
    UPDATE app.retention_batches SET status='completed',completed_at=clock_timestamp(),
      lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
      updated_at=clock_timestamp() WHERE id=p_batch_id;
    INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
    VALUES(gen_random_uuid(),v_batch.workspace_id,'retention.batch_completed',
      'retention-batch',p_batch_id,jsonb_build_object('retentionKind',v_batch.retention_kind,
      'dryRun',false,'examinedCount',v_batch.examined_count,'eligibleCount',v_batch.eligible_count));
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT 'completed'::varchar,0,0,NULL::timestamptz,NULL::uuid;
    RETURN;
  END IF;
  UPDATE app.retention_batches SET
    retention_stage=CASE WHEN v_count=0 THEN v_next_stage ELSE retention_stage END,
    examined_count=examined_count+v_count,eligible_count=eligible_count+v_count,
    updated_at=clock_timestamp() WHERE id=p_batch_id;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT 'progressed'::varchar,v_count,v_count,NULL::timestamptz,NULL::uuid;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

-- Complete final registered dry-run body: metrics count physical run rows.
CREATE OR REPLACE FUNCTION app.standard_retention_dry_run_stage_keys(
  p_workspace_id uuid,p_retention_kind varchar,p_retention_stage varchar,
  p_cutoff_at timestamptz,p_cursor jsonb,p_upper jsonb,p_descending boolean,
  p_limit integer
) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_from text;
  v_filter text;
  v_eligible text:='true';
  v_key text;
  v_order text;
  v_typed_bounds text;
  v_typed_upper text;
BEGIN
  IF p_workspace_id IS NULL OR p_cutoff_at IS NULL OR p_descending IS NULL
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1001 THEN
    RAISE EXCEPTION 'invalid standard retention dry-run stage page' USING ERRCODE='22023';
  END IF;
  IF p_retention_kind='execution_detail' AND p_retention_stage='records' THEN
    v_from:='app.workflow_runs run';
    v_filter:='run.workspace_id=$1 AND run.details_purged_at IS NULL AND run.completed_at<=$2-interval ''30 days''';
    v_eligible:='app.native_retention_family_eligible(run.id,$2,false)';
    v_order:='run.completed_at,run.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(run.completed_at,run.id))';
    v_typed_bounds:='(run.completed_at,run.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='run_summary' AND p_retention_stage='records' THEN
    v_from:='app.workflow_runs run';
    v_filter:='run.workspace_id=$1 AND run.completed_at<=$2-interval ''90 days''';
    v_eligible:='run.details_purged_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.workflow_runs child WHERE child.workspace_id=run.workspace_id AND child.replay_source_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_deliveries delivery WHERE delivery.workspace_id=run.workspace_id AND delivery.workflow_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay WHERE replay.workspace_id=run.workspace_id AND replay.workflow_run_id=run.id) AND NOT EXISTS (SELECT 1 FROM app.trigger_schedule_occurrences occurrence WHERE occurrence.workspace_id=run.workspace_id AND occurrence.workflow_run_id=run.id) AND app.native_retention_family_eligible(run.id,$2,true)';
    v_order:='run.completed_at,run.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(run.completed_at,run.id))';
    v_typed_bounds:='(run.completed_at,run.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(run.completed_at,run.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='trigger_summary' AND p_retention_stage='replay' THEN
    v_from:='app.webhook_trigger_replay_records replay';
    v_filter:='replay.workspace_id=$1 AND replay.expires_at<=$2';
    v_order:='replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid_text_text'',''values'',jsonb_build_array(replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash))';
    v_typed_bounds:='(replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid,$3->''values''->>2,$3->''values''->>3) AND (replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid,$4->''values''->>2,$4->''values''->>3)';
    v_typed_upper:='(replay.expires_at,replay.endpoint_id,replay.dedupe_kind,replay.dedupe_key_hash)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid,$4->''values''->>2,$4->''values''->>3)';
  ELSIF p_retention_kind='trigger_summary' AND p_retention_stage='deliveries' THEN
    v_from:='app.webhook_trigger_deliveries delivery';
    v_filter:='delivery.workspace_id=$1 AND delivery.expires_at<=$2';
    v_eligible:='NOT EXISTS (SELECT 1 FROM app.webhook_trigger_replay_records replay WHERE replay.workspace_id=delivery.workspace_id AND replay.delivery_id=delivery.id AND replay.expires_at>$2)';
    v_order:='delivery.expires_at,delivery.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(delivery.expires_at,delivery.id))';
    v_typed_bounds:='(delivery.expires_at,delivery.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (delivery.expires_at,delivery.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(delivery.expires_at,delivery.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='trigger_summary' AND p_retention_stage='occurrences' THEN
    v_from:='app.trigger_schedule_occurrences occurrence';
    v_filter:='occurrence.workspace_id=$1 AND occurrence.scheduled_at<=$2-interval ''90 days''';
    v_order:='occurrence.scheduled_at,occurrence.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(occurrence.scheduled_at,occurrence.id))';
    v_typed_bounds:='(occurrence.scheduled_at,occurrence.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (occurrence.scheduled_at,occurrence.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(occurrence.scheduled_at,occurrence.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='audit_security' AND p_retention_stage='audit' THEN
    v_from:='app.audit_events audit';
    v_filter:='audit.workspace_id=$1 AND audit.occurred_at<=$2-interval ''365 days''';
    v_order:='audit.occurred_at,audit.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(audit.occurred_at,audit.id))';
    v_typed_bounds:='(audit.occurred_at,audit.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (audit.occurred_at,audit.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(audit.occurred_at,audit.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSIF p_retention_kind='audit_security' AND p_retention_stage='transport' THEN
    v_from:='app.transport_security_audit_facts fact';
    v_filter:='fact.workspace_id=$1 AND fact.occurred_at<=$2-interval ''365 days''';
    v_order:='fact.occurred_at,fact.id';
    v_key:='jsonb_build_object(''type'',''timestamp_uuid'',''values'',jsonb_build_array(fact.occurred_at,fact.id))';
    v_typed_bounds:='(fact.occurred_at,fact.id)>(($3->''values''->>0)::timestamptz,($3->''values''->>1)::uuid) AND (fact.occurred_at,fact.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
    v_typed_upper:='(fact.occurred_at,fact.id)<=(($4->''values''->>0)::timestamptz,($4->''values''->>1)::uuid)';
  ELSE
    RAISE EXCEPTION 'invalid standard retention dry-run stage' USING ERRCODE='22023';
  END IF;
  IF p_descending THEN
    RETURN QUERY EXECUTE 'SELECT jsonb_build_object(''key'','||v_key
      ||',''eligible'',('||v_eligible||')) FROM '||v_from||' WHERE '||v_filter
      ||' ORDER BY '||replace(v_order,',',' DESC,')||' DESC LIMIT $5'
      USING p_workspace_id,p_cutoff_at,p_cursor,p_upper,p_limit;
  ELSIF p_upper IS NOT NULL THEN
    RETURN QUERY EXECUTE 'SELECT jsonb_build_object(''key'','||v_key
      ||',''eligible'',('||v_eligible||')) FROM '||v_from||' WHERE '||v_filter
      ||' AND ('||CASE WHEN p_cursor IS NULL THEN v_typed_upper ELSE v_typed_bounds END
      ||') ORDER BY '||v_order||' LIMIT $5'
      USING p_workspace_id,p_cutoff_at,p_cursor,p_upper,p_limit;
  END IF;
END $$;

-- through FORCE RLS. Only the existing owner role receives scoped owner policies;

-- through FORCE RLS. Only the existing owner role receives scoped owner policies;
-- runtime roles still have NO native table DML/SELECT. Deferred trigger bodies
-- are SECURITY DEFINER too: COMMIT runs after record's definer context returns,
-- so an invoker trigger could otherwise see no rows or fail its own obligation.
-- Complete final 0135 purge wrapper; retain the full registered alias chain
-- (folders -> organization -> input cases -> existing patched base). No stale
-- 0087 replacement, runtime body rewrite or extra destructive owner.
DO $native_purge_owner_drift$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
      IS DISTINCT FROM 'c19d0d7f7d347550eba8c52564144a86' THEN
    RAISE EXCEPTION 'native purge registered owner body drifted' USING ERRCODE='55000';
  END IF;
END $native_purge_owner_drift$;

CREATE OR REPLACE FUNCTION app.execute_workspace_tenant_rows_page(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_size integer,
  p_projected_sequence bigint,p_projected_hash char(64)
) RETURNS TABLE(surface varchar,affected_count integer,completed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE; v_step app.workspace_purge_steps%ROWTYPE;
  v_count integer:=0; v_table text;
BEGIN
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid purge page' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job missing' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_step FROM app.workspace_purge_steps WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token IS DISTINCT FROM p_lease_token OR v_step.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_step.lease_expires_at IS NULL OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'purge lease stale' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_job.workspace_id AND status='purging'
    AND retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_job.workspace_id AND released_sequence IS NULL) THEN
    RAISE EXCEPTION 'legal hold blocks purge' USING ERRCODE='55000'; END IF;

  -- BEGIN NATIVE PURGE DEPENDENCIES: metadata only, one relation/page.
  -- The real lifecycle caller installs tenant scope from the claimed job.
  -- Scope/token flags are not authority: the actual job/step/control/hold proof
  -- above remains the sole existing destructive owner.
  IF nullif(current_setting('app.workspace_id',true),'')::uuid
      IS DISTINCT FROM v_job.workspace_id THEN
    RAISE EXCEPTION 'native purge tenant scope differs' USING ERRCODE='55000';
  END IF;
  FOREACH v_table IN ARRAY ARRAY[
    'workflow_execution_value_artifact_associations',
    'workflow_execution_value_borrowed_provenance',
    'workflow_calls',
    'workflow_execution_value_owned_provenance',
    'workflow_execution_value_artifact_candidates'
  ] LOOP
    IF v_table='workflow_execution_value_borrowed_provenance' THEN
      WITH candidates AS (SELECT source.id FROM app.workflow_execution_value_provenance source
        WHERE source.workspace_id=v_job.workspace_id AND source.byte_ownership='borrowed'
        ORDER BY source.id LIMIT p_page_size FOR UPDATE)
      DELETE FROM app.workflow_execution_value_provenance source USING candidates
        WHERE source.workspace_id=v_job.workspace_id AND source.id=candidates.id;
    ELSIF v_table='workflow_execution_value_owned_provenance' THEN
      WITH candidates AS (SELECT source.id FROM app.workflow_execution_value_provenance source
        WHERE source.workspace_id=v_job.workspace_id AND source.byte_ownership='owned'
        ORDER BY source.id LIMIT p_page_size FOR UPDATE)
      DELETE FROM app.workflow_execution_value_provenance source USING candidates
        WHERE source.workspace_id=v_job.workspace_id AND source.id=candidates.id;
    ELSE
      -- All relation names come from this closed private list, never a caller.
      EXECUTE format('WITH candidates AS (SELECT ctid FROM app.%I WHERE workspace_id=$1 ORDER BY ctid LIMIT $2 FOR UPDATE)
        DELETE FROM app.%I row USING candidates WHERE row.ctid=candidates.ctid',v_table,v_table)
        USING v_job.workspace_id,p_page_size;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
      -- A bounded metadata page never deletes physical objects or charges quota.
      -- Object-version purge/HEAD and accounting remain their existing owners.
      IF v_step.lease_expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'native purge lease expired' USING ERRCODE='55000';
      END IF;
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;
    END IF;
  END LOOP;
  -- END NATIVE PURGE DEPENDENCIES.
  FOREACH v_table IN ARRAY ARRAY['workflow_favorite_receipts','workflow_favorite_held_evidence',
    'workflow_favorites','workflow_organization_receipts','workflow_tag_assignments',
    'workflow_organization_state','workflow_folders'] LOOP
    IF v_table='workflow_folders' THEN
      WITH candidates AS (SELECT f.ctid FROM app.workflow_folders f WHERE f.workspace_id=v_job.workspace_id
        AND NOT EXISTS(SELECT 1 FROM app.workflow_folders child WHERE child.workspace_id=f.workspace_id AND child.parent_id=f.id)
        ORDER BY f.id LIMIT p_page_size FOR UPDATE)
      DELETE FROM app.workflow_folders f USING candidates c WHERE f.ctid=c.ctid;
    ELSE
      EXECUTE format('WITH candidates AS(SELECT ctid FROM app.%I WHERE workspace_id=$1 LIMIT $2 FOR UPDATE)
        DELETE FROM app.%I r USING candidates c WHERE r.ctid=c.ctid',v_table,v_table)
        USING v_job.workspace_id,p_page_size;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
      PERFORM set_config('app.workspace_purge_transition','on',true);
      UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job_id=p_job_id AND step_name='tenant_rows';
      RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_folders(
    p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $$;

CREATE POLICY native_value_provenance_owner_scope ON app.workflow_execution_value_provenance
  TO {{owner_role}}
  USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY native_value_candidate_owner_scope ON app.workflow_execution_value_artifact_candidates
  TO {{owner_role}}
  USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY native_value_association_owner_scope ON app.workflow_execution_value_artifact_associations
  TO {{owner_role}}
  USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY native_call_journal_owner_scope ON app.workflow_calls
  TO {{owner_role}}
  USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
GRANT EXECUTE ON FUNCTION app.record_workflow_call_declaration_input(jsonb,jsonb,text,integer,text),
  app.read_workflow_call_declaration_input(jsonb),
  app.workflow_call_declaration_completion_reference(jsonb) TO {{worker_runtime_role}};
GRANT EXECUTE ON FUNCTION app.record_native_root_execution_input(uuid,uuid,text)
  TO {{api_runtime_role}},{{worker_runtime_role}};

-- These are prospective statements in an UNREGISTERED GUARDED source candidate,
-- not applied permissions or readiness. Record/read now earn their exact grants
-- in the existing adapters; root acceptance's additional grant is likewise
-- bound to its actual canonical transaction. Native publication and adversarial command/table
-- authority still require exact review/qualification before installation.
