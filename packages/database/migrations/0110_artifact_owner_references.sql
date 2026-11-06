CREATE TABLE "app"."artifact_owner_references" (
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"owner_family" varchar(40) NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_sub_id" integer NOT NULL,
	"owner_slot" varchar(32) NOT NULL,
	CONSTRAINT "artifact_owner_references_pkey" PRIMARY KEY("workspace_id","artifact_id","owner_family","owner_id","owner_sub_id","owner_slot"),
	CONSTRAINT "artifact_owner_references_sub_id_valid" CHECK (owner_sub_id>=0),
	CONSTRAINT "artifact_owner_references_family_valid" CHECK (owner_family in ('workflow_drafts','workflow_versions','workflow_test_snapshots','workflow_test_suite_cases','workflow_input_case_payloads','workflow_step_samples','preview_runs','workflow_runs','node_runs','node_attempts','run_events','run_checkpoints','pending_run_tasks'))
);
--> statement-breakpoint
ALTER TABLE "app"."artifact_owner_references" ADD CONSTRAINT "artifact_owner_references_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_owner_references_owner_idx" ON "app"."artifact_owner_references" USING btree ("workspace_id","owner_family","owner_id","owner_sub_id");
--> statement-breakpoint
--> statement-breakpoint
-- Derived storage index maintenance. Core still decides authority and retention.
ALTER TABLE app.artifact_owner_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.artifact_owner_references FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_owner_references_workspace_scope ON app.artifact_owner_references
  TO {{owner_role}}, {{app_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY artifact_owner_references_maintenance ON app.artifact_owner_references
  TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT ON app.artifact_owner_references TO {{app_role}}, {{maintenance_role}};
-- Only the storage trigger's owner writes this derived index, never an API command.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.artifact_owner_references FROM {{app_role}}, {{maintenance_role}};
--> statement-breakpoint
CREATE FUNCTION app.artifact_owner_ids(p_value jsonb,p_format text)
RETURNS SETOF uuid LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path TO 'pg_catalog','app','pg_temp'
AS $$
DECLARE v_value jsonb:=p_value; v_format text:=p_format;
BEGIN
  IF right(v_format,5)='-text' THEN
    -- Index maintenance is not a second stored-document validator.
    BEGIN v_value:=(p_value #>> '{}')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN RETURN;
    END;
    v_format:=left(v_format,length(v_format)-5);
  END IF;
  IF v_format='authored' THEN
    RETURN QUERY SELECT DISTINCT (reference #>> '{}')::uuid
      FROM jsonb_path_query(v_value,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId) && exists(@.byteLength) && exists(@.mediaType) && exists(@.sha256)).artifactId'::jsonpath) reference
      WHERE jsonb_typeof(reference)='string'
        AND reference #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  ELSE
    RETURN QUERY SELECT * FROM app.execution_artifact_ids(v_value,v_format);
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.artifact_owner_ids(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.artifact_owner_ids(jsonb,text) TO {{app_role}}, {{maintenance_role}};
COMMENT ON FUNCTION app.artifact_owner_ids(jsonb,text) IS
  'Derived storage: authored descriptors use the shared SDK descriptor shape; execution values use the existing batch-C extractor. No visibility, admission, expiry or retention policy.';
--> statement-breakpoint
CREATE FUNCTION app.replace_artifact_owner_references(
  p_workspace uuid,p_family text,p_owner uuid,p_sub_id integer,p_row jsonb,p_values jsonb
) RETURNS void LANGUAGE plpgsql
SET search_path TO 'pg_catalog','app','pg_temp'
SET row_security TO 'on'
AS $$
DECLARE v_scope text:=current_setting('app.workspace_id',true); v_workspace uuid;
BEGIN
  IF p_workspace IS NULL THEN
    -- Owner-table TRUNCATE is global; its statement trigger uses this same writer.
    FOR v_workspace IN SELECT id FROM app.workspaces LOOP
      PERFORM app.replace_artifact_owner_references(v_workspace,p_family,NULL,NULL,NULL,'{}');
    END LOOP;
    RETURN;
  END IF;
  -- The trigger already runs after the source table's workspace/RLS check.
  -- Maintenance can touch several workspaces; restore its context after this row.
  PERFORM set_config('app.workspace_id',p_workspace::text,true);
  DELETE FROM app.artifact_owner_references
    WHERE workspace_id=p_workspace AND owner_family=p_family
      AND (p_owner IS NULL OR owner_id=p_owner) AND (p_sub_id IS NULL OR owner_sub_id=p_sub_id);
  INSERT INTO app.artifact_owner_references
    (workspace_id,artifact_id,owner_family,owner_id,owner_sub_id,owner_slot)
    SELECT DISTINCT p_workspace,reference,p_family,p_owner,p_sub_id,source.key
    FROM jsonb_each_text(p_values) source
    CROSS JOIN LATERAL app.artifact_owner_ids(p_row->source.key,source.value) reference
    ON CONFLICT DO NOTHING;
  PERFORM set_config('app.workspace_id',coalesce(v_scope,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_scope,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION app.replace_artifact_owner_references(uuid,text,uuid,integer,jsonb,jsonb) FROM PUBLIC;
COMMENT ON FUNCTION app.replace_artifact_owner_references(uuid,text,uuid,integer,jsonb,jsonb) IS
  'Single derived-index writer. Only the owner-only trigger adapter and migration backfill call it; JSON remains authoritative. Atomic replacement has the source row lock, and preserves the caller workspace context.';
--> statement-breakpoint
CREATE FUNCTION app.index_artifact_owner_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','app','pg_temp'
SET row_security TO 'on'
AS $$
DECLARE v_row jsonb; v_old jsonb; v_values jsonb:=TG_ARGV[2]::jsonb;
  v_owner uuid; v_sub integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    PERFORM app.replace_artifact_owner_references(NULL,TG_TABLE_NAME,NULL,NULL,NULL,'{}');
    RETURN NULL;
  END IF;
  IF TG_OP<>'INSERT' THEN
    v_old:=to_jsonb(OLD);
    IF TG_OP='DELETE' OR
      (v_old->>'workspace_id',v_old->>TG_ARGV[0],coalesce(v_old->>TG_ARGV[1],'0')) IS DISTINCT FROM
      (NEW.workspace_id::text,to_jsonb(NEW)->>TG_ARGV[0],coalesce(to_jsonb(NEW)->>TG_ARGV[1],'0')) THEN
      PERFORM app.replace_artifact_owner_references(
        (v_old->>'workspace_id')::uuid,TG_TABLE_NAME,(v_old->>TG_ARGV[0])::uuid,
        coalesce((v_old->>TG_ARGV[1])::integer,0),NULL,'{}'::jsonb);
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_row:=to_jsonb(NEW);
    -- A SET of an unchanged document need not rewrite its index rows.
    IF TG_OP='UPDATE' AND v_old=v_row THEN RETURN NEW; END IF;
    PERFORM app.replace_artifact_owner_references(
      NEW.workspace_id,TG_TABLE_NAME,(v_row->>TG_ARGV[0])::uuid,
      coalesce((v_row->>TG_ARGV[1])::integer,0),v_row,v_values);
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.index_artifact_owner_references() FROM PUBLIC;
COMMENT ON FUNCTION app.index_artifact_owner_references() IS
  'Storage-only trigger adapter for the derived reference index. It covers every owner SQL writer and cascade, while source RLS and core retain their existing authority, artifact locks and lifetime rules.';
--> statement-breakpoint
CREATE TRIGGER workflow_drafts_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,workflow_id,graph_json OR DELETE ON app.workflow_drafts
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id','','{"graph_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_drafts_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_drafts FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id','','{"graph_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_versions_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,graph_json OR DELETE ON app.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_versions_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_versions FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_test_snapshots_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,graph_json OR DELETE ON app.workflow_test_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_test_snapshots_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_test_snapshots FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_test_suite_cases_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,suite_id,ordinal,input OR DELETE ON app.workflow_test_suite_cases
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('suite_id','ordinal','{"input":"authored-text"}');
--> statement-breakpoint
CREATE TRIGGER workflow_test_suite_cases_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_test_suite_cases FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('suite_id','ordinal','{"input":"authored-text"}');
--> statement-breakpoint
CREATE TRIGGER workflow_input_case_payloads_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,case_id,revision,input OR DELETE ON app.workflow_input_case_payloads
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('case_id','revision','{"input":"authored-text"}');
--> statement-breakpoint
CREATE TRIGGER workflow_input_case_payloads_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_input_case_payloads FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('case_id','revision','{"input":"authored-text"}');
--> statement-breakpoint
CREATE TRIGGER workflow_step_samples_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,output_ref OR DELETE ON app.workflow_step_samples
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value-text"}');
--> statement-breakpoint
CREATE TRIGGER workflow_step_samples_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_step_samples FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value-text"}');
--> statement-breakpoint
CREATE TRIGGER preview_runs_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,input_ref,output_ref,executable_node_json OR DELETE ON app.preview_runs
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER preview_runs_artifact_owner_truncate AFTER TRUNCATE ON app.preview_runs FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');
--> statement-breakpoint
CREATE TRIGGER workflow_runs_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,input_ref,output_ref OR DELETE ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER workflow_runs_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_runs FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER node_runs_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,input_ref,output_ref OR DELETE ON app.node_runs
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER node_runs_artifact_owner_truncate AFTER TRUNCATE ON app.node_runs FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER node_attempts_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,output_ref,reconciliation_ref OR DELETE ON app.node_attempts
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value","reconciliation_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER node_attempts_artifact_owner_truncate AFTER TRUNCATE ON app.node_attempts FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value","reconciliation_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER run_events_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,workflow_run_id,sequence,payload OR DELETE ON app.run_events
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','sequence','{"payload":"event"}');
--> statement-breakpoint
CREATE TRIGGER run_events_artifact_owner_truncate AFTER TRUNCATE ON app.run_events FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','sequence','{"payload":"event"}');
--> statement-breakpoint
CREATE TRIGGER run_checkpoints_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,workflow_run_id,scheduler_state OR DELETE ON app.run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','','{"scheduler_state":"checkpoint"}');
--> statement-breakpoint
CREATE TRIGGER run_checkpoints_artifact_owner_truncate AFTER TRUNCATE ON app.run_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','','{"scheduler_state":"checkpoint"}');
--> statement-breakpoint
CREATE TRIGGER pending_run_tasks_artifact_owner_index AFTER INSERT OR UPDATE OF workspace_id,id,output_ref OR DELETE ON app.pending_run_tasks
  FOR EACH ROW EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value"}');
--> statement-breakpoint
CREATE TRIGGER pending_run_tasks_artifact_owner_truncate AFTER TRUNCATE ON app.pending_run_tasks FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value"}');
--> statement-breakpoint
-- The migration runner commits schema, backfill and receipt atomically. Source
-- trigger DDL blocks concurrent writes until the index is complete. Owner-only
-- NO FORCE is scoped to this transaction and restored before it can commit;
-- application policies/grants never change. Sixteen rows bound each JSON page.
DO $$
DECLARE source jsonb; owner_row record; v_row jsonb; v_workspace uuid;
  v_owner uuid; v_sub integer; v_last_workspace uuid; v_last_owner uuid; v_last_sub integer;
  v_where text; v_order text; v_query text; v_count integer; v_scope_first boolean;
BEGIN
  FOR source IN SELECT value FROM jsonb_array_elements('[{"table":"workflow_drafts","id":"workflow_id","sub":null,"values":{"graph_json":"authored"}},{"table":"workflow_versions","id":"id","sub":null,"values":{"graph_json":"authored"}},{"table":"workflow_test_snapshots","id":"id","sub":null,"values":{"graph_json":"authored"}},{"table":"workflow_test_suite_cases","id":"suite_id","sub":"ordinal","values":{"input":"authored-text"}},{"table":"workflow_input_case_payloads","id":"case_id","sub":"revision","values":{"input":"authored-text"}},{"table":"workflow_step_samples","id":"id","sub":null,"values":{"output_ref":"value-text"}},{"table":"preview_runs","id":"id","sub":null,"values":{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}},{"table":"workflow_runs","id":"id","sub":null,"values":{"input_ref":"value","output_ref":"value"}},{"table":"node_runs","id":"id","sub":null,"values":{"input_ref":"value","output_ref":"value"}},{"table":"node_attempts","id":"id","sub":null,"values":{"output_ref":"value","reconciliation_ref":"value"}},{"table":"run_events","id":"workflow_run_id","sub":"sequence","values":{"payload":"event"}},{"table":"run_checkpoints","id":"workflow_run_id","sub":null,"values":{"scheduler_state":"checkpoint"}},{"table":"pending_run_tasks","id":"id","sub":null,"values":{"output_ref":"value"}}]'::jsonb) LOOP
    EXECUTE format('ALTER TABLE app.%I NO FORCE ROW LEVEL SECURITY',source->>'table');
    v_last_workspace:=NULL; v_last_owner:=NULL; v_last_sub:=NULL;
    v_scope_first:=source->>'table' IN ('workflow_input_case_payloads','workflow_test_suite_cases');
    LOOP
      v_where:='true';
      IF v_last_owner IS NOT NULL THEN
        IF v_scope_first THEN
          v_where:=format('(workspace_id,%I,%I)>(%L::uuid,%L::uuid,%s)',
            source->>'id',source->>'sub',v_last_workspace,v_last_owner,v_last_sub);
        ELSIF source->>'sub' IS NOT NULL THEN
          v_where:=format('(%I,%I)>(%L::uuid,%s)',source->>'id',source->>'sub',v_last_owner,v_last_sub);
        ELSE
          v_where:=format('%I>%L::uuid',source->>'id',v_last_owner);
        END IF;
      END IF;
      v_order:=CASE WHEN v_scope_first THEN 'workspace_id,' ELSE '' END
        ||format('%I',source->>'id')
        ||CASE WHEN source->>'sub' IS NOT NULL THEN ','||format('%I',source->>'sub') ELSE '' END;
      v_query:=format('SELECT to_jsonb(owner) AS value FROM app.%I owner WHERE %s ORDER BY %s LIMIT 16',
        source->>'table',v_where,v_order);
      v_count:=0;
      FOR owner_row IN EXECUTE v_query LOOP
        v_row:=owner_row.value;v_workspace:=(v_row->>'workspace_id')::uuid;
        v_owner:=(v_row->>(source->>'id'))::uuid;
        v_sub:=coalesce((v_row->>(source->>'sub'))::integer,0);
        PERFORM app.replace_artifact_owner_references(v_workspace,source->>'table',v_owner,v_sub,v_row,source->'values');
        v_last_workspace:=v_workspace;v_last_owner:=v_owner;v_last_sub:=v_sub;
        v_count:=v_count+1;
      END LOOP;
      EXIT WHEN v_count<16;
    END LOOP;
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',source->>'table');
  END LOOP;
END $$;
