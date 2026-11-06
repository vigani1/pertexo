-- Necessary descriptor shape only: the existing extractor remains authoritative.
-- The shared SDK-derived presence path is checked against these guards in core tests.
CREATE FUNCTION app.artifact_owner_text_may_reference(p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path TO 'pg_catalog','app','pg_temp'
AS $$
BEGIN
  RETURN jsonb_path_exists(p_value::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.artifact_owner_text_may_reference(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.artifact_owner_text_may_reference(text) TO {{app_role}}, {{maintenance_role}};
COMMENT ON FUNCTION app.artifact_owner_text_may_reference(text) IS
  'Derived storage precheck for text-backed owner JSON; malformed stored documents cannot contain an extractable descriptor.';
--> statement-breakpoint
DROP TRIGGER workflow_drafts_artifact_owner_index ON app.workflow_drafts;
CREATE TRIGGER workflow_drafts_artifact_owner_insert AFTER INSERT ON app.workflow_drafts
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id','','{"graph_json":"authored"}');
CREATE TRIGGER workflow_drafts_artifact_owner_delete AFTER DELETE ON app.workflow_drafts
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id','','{"graph_json":"authored"}');
CREATE TRIGGER workflow_drafts_artifact_owner_update AFTER UPDATE OF workspace_id,workflow_id,graph_json ON app.workflow_drafts
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.workflow_id,OLD.graph_json::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.workflow_id,NEW.graph_json::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id','','{"graph_json":"authored"}');
--> statement-breakpoint
DROP TRIGGER workflow_versions_artifact_owner_index ON app.workflow_versions;
CREATE TRIGGER workflow_versions_artifact_owner_insert AFTER INSERT ON app.workflow_versions
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
CREATE TRIGGER workflow_versions_artifact_owner_delete AFTER DELETE ON app.workflow_versions
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
CREATE TRIGGER workflow_versions_artifact_owner_update AFTER UPDATE OF workspace_id,id,graph_json ON app.workflow_versions
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.graph_json::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.graph_json::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
--> statement-breakpoint
DROP TRIGGER workflow_test_snapshots_artifact_owner_index ON app.workflow_test_snapshots;
CREATE TRIGGER workflow_test_snapshots_artifact_owner_insert AFTER INSERT ON app.workflow_test_snapshots
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
CREATE TRIGGER workflow_test_snapshots_artifact_owner_delete AFTER DELETE ON app.workflow_test_snapshots
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
CREATE TRIGGER workflow_test_snapshots_artifact_owner_update AFTER UPDATE OF workspace_id,id,graph_json ON app.workflow_test_snapshots
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.graph_json::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.graph_json::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.graph_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"graph_json":"authored"}');
--> statement-breakpoint
DROP TRIGGER workflow_test_suite_cases_artifact_owner_index ON app.workflow_test_suite_cases;
CREATE TRIGGER workflow_test_suite_cases_artifact_owner_insert AFTER INSERT ON app.workflow_test_suite_cases
  FOR EACH ROW WHEN (coalesce(app.artifact_owner_text_may_reference(NEW.input),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('suite_id','ordinal','{"input":"authored-text"}');
CREATE TRIGGER workflow_test_suite_cases_artifact_owner_delete AFTER DELETE ON app.workflow_test_suite_cases
  FOR EACH ROW WHEN (coalesce(app.artifact_owner_text_may_reference(OLD.input),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('suite_id','ordinal','{"input":"authored-text"}');
CREATE TRIGGER workflow_test_suite_cases_artifact_owner_update AFTER UPDATE OF workspace_id,suite_id,ordinal,input ON app.workflow_test_suite_cases
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.suite_id,OLD.ordinal,OLD.input) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.suite_id,NEW.ordinal,NEW.input)
    AND (coalesce(app.artifact_owner_text_may_reference(OLD.input),false) OR coalesce(app.artifact_owner_text_may_reference(NEW.input),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('suite_id','ordinal','{"input":"authored-text"}');
--> statement-breakpoint
DROP TRIGGER workflow_input_case_payloads_artifact_owner_index ON app.workflow_input_case_payloads;
CREATE TRIGGER workflow_input_case_payloads_artifact_owner_insert AFTER INSERT ON app.workflow_input_case_payloads
  FOR EACH ROW WHEN (coalesce(app.artifact_owner_text_may_reference(NEW.input),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('case_id','revision','{"input":"authored-text"}');
CREATE TRIGGER workflow_input_case_payloads_artifact_owner_delete AFTER DELETE ON app.workflow_input_case_payloads
  FOR EACH ROW WHEN (coalesce(app.artifact_owner_text_may_reference(OLD.input),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('case_id','revision','{"input":"authored-text"}');
CREATE TRIGGER workflow_input_case_payloads_artifact_owner_update AFTER UPDATE OF workspace_id,case_id,revision,input ON app.workflow_input_case_payloads
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.case_id,OLD.revision,OLD.input) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.case_id,NEW.revision,NEW.input)
    AND (coalesce(app.artifact_owner_text_may_reference(OLD.input),false) OR coalesce(app.artifact_owner_text_may_reference(NEW.input),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('case_id','revision','{"input":"authored-text"}');
--> statement-breakpoint
DROP TRIGGER workflow_step_samples_artifact_owner_index ON app.workflow_step_samples;
CREATE TRIGGER workflow_step_samples_artifact_owner_insert AFTER INSERT ON app.workflow_step_samples
  FOR EACH ROW WHEN (coalesce(app.artifact_owner_text_may_reference(NEW.output_ref),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value-text"}');
CREATE TRIGGER workflow_step_samples_artifact_owner_delete AFTER DELETE ON app.workflow_step_samples
  FOR EACH ROW WHEN (coalesce(app.artifact_owner_text_may_reference(OLD.output_ref),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value-text"}');
CREATE TRIGGER workflow_step_samples_artifact_owner_update AFTER UPDATE OF workspace_id,id,output_ref ON app.workflow_step_samples
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.output_ref) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.output_ref)
    AND (coalesce(app.artifact_owner_text_may_reference(OLD.output_ref),false) OR coalesce(app.artifact_owner_text_may_reference(NEW.output_ref),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value-text"}');
--> statement-breakpoint
DROP TRIGGER preview_runs_artifact_owner_index ON app.preview_runs;
CREATE TRIGGER preview_runs_artifact_owner_insert AFTER INSERT ON app.preview_runs
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.executable_node_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');
CREATE TRIGGER preview_runs_artifact_owner_delete AFTER DELETE ON app.preview_runs
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.executable_node_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');
CREATE TRIGGER preview_runs_artifact_owner_update AFTER UPDATE OF workspace_id,id,input_ref,output_ref,executable_node_json ON app.preview_runs
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.input_ref::jsonb,OLD.output_ref::jsonb,OLD.executable_node_json::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.input_ref::jsonb,NEW.output_ref::jsonb,NEW.executable_node_json::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.executable_node_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.executable_node_json::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');
--> statement-breakpoint
DROP TRIGGER workflow_runs_artifact_owner_index ON app.workflow_runs;
CREATE TRIGGER workflow_runs_artifact_owner_insert AFTER INSERT ON app.workflow_runs
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
CREATE TRIGGER workflow_runs_artifact_owner_delete AFTER DELETE ON app.workflow_runs
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
CREATE TRIGGER workflow_runs_artifact_owner_update AFTER UPDATE OF workspace_id,id,input_ref,output_ref ON app.workflow_runs
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.input_ref::jsonb,OLD.output_ref::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.input_ref::jsonb,NEW.output_ref::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
--> statement-breakpoint
DROP TRIGGER node_runs_artifact_owner_index ON app.node_runs;
CREATE TRIGGER node_runs_artifact_owner_insert AFTER INSERT ON app.node_runs
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
CREATE TRIGGER node_runs_artifact_owner_delete AFTER DELETE ON app.node_runs
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
CREATE TRIGGER node_runs_artifact_owner_update AFTER UPDATE OF workspace_id,id,input_ref,output_ref ON app.node_runs
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.input_ref::jsonb,OLD.output_ref::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.input_ref::jsonb,NEW.output_ref::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.input_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"input_ref":"value","output_ref":"value"}');
--> statement-breakpoint
DROP TRIGGER node_attempts_artifact_owner_index ON app.node_attempts;
CREATE TRIGGER node_attempts_artifact_owner_insert AFTER INSERT ON app.node_attempts
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.reconciliation_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value","reconciliation_ref":"value"}');
CREATE TRIGGER node_attempts_artifact_owner_delete AFTER DELETE ON app.node_attempts
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.reconciliation_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value","reconciliation_ref":"value"}');
CREATE TRIGGER node_attempts_artifact_owner_update AFTER UPDATE OF workspace_id,id,output_ref,reconciliation_ref ON app.node_attempts
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.output_ref::jsonb,OLD.reconciliation_ref::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.output_ref::jsonb,NEW.reconciliation_ref::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(OLD.reconciliation_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.reconciliation_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value","reconciliation_ref":"value"}');
--> statement-breakpoint
DROP TRIGGER run_events_artifact_owner_index ON app.run_events;
CREATE TRIGGER run_events_artifact_owner_insert AFTER INSERT ON app.run_events
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.payload::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','sequence','{"payload":"event"}');
CREATE TRIGGER run_events_artifact_owner_delete AFTER DELETE ON app.run_events
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.payload::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','sequence','{"payload":"event"}');
CREATE TRIGGER run_events_artifact_owner_update AFTER UPDATE OF workspace_id,workflow_run_id,sequence,payload ON app.run_events
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.workflow_run_id,OLD.sequence,OLD.payload::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.workflow_run_id,NEW.sequence,NEW.payload::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.payload::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.payload::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','sequence','{"payload":"event"}');
--> statement-breakpoint
DROP TRIGGER run_checkpoints_artifact_owner_index ON app.run_checkpoints;
CREATE TRIGGER run_checkpoints_artifact_owner_insert AFTER INSERT ON app.run_checkpoints
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.scheduler_state::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','','{"scheduler_state":"checkpoint"}');
CREATE TRIGGER run_checkpoints_artifact_owner_delete AFTER DELETE ON app.run_checkpoints
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.scheduler_state::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','','{"scheduler_state":"checkpoint"}');
CREATE TRIGGER run_checkpoints_artifact_owner_update AFTER UPDATE OF workspace_id,workflow_run_id,scheduler_state ON app.run_checkpoints
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.workflow_run_id,OLD.scheduler_state::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.workflow_run_id,NEW.scheduler_state::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.scheduler_state::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.scheduler_state::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id','','{"scheduler_state":"checkpoint"}');
--> statement-breakpoint
DROP TRIGGER pending_run_tasks_artifact_owner_index ON app.pending_run_tasks;
CREATE TRIGGER pending_run_tasks_artifact_owner_insert AFTER INSERT ON app.pending_run_tasks
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value"}');
CREATE TRIGGER pending_run_tasks_artifact_owner_delete AFTER DELETE ON app.pending_run_tasks
  FOR EACH ROW WHEN (coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value"}');
CREATE TRIGGER pending_run_tasks_artifact_owner_update AFTER UPDATE OF workspace_id,id,output_ref ON app.pending_run_tasks
  FOR EACH ROW WHEN (ROW(OLD.workspace_id,OLD.id,OLD.output_ref::jsonb) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.id,NEW.output_ref::jsonb)
    AND (coalesce(jsonb_path_exists(OLD.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false) OR coalesce(jsonb_path_exists(NEW.output_ref::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath),false)))
  EXECUTE FUNCTION app.index_artifact_owner_references('id','','{"output_ref":"value"}');
