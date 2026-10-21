/** Run inputs, outputs, events and checkpoints that still name the artifact. */
export const REFERENCED = `
  select exists (select 1 from app.workflow_test_snapshots snapshot
      where snapshot.workspace_id=$1 and snapshot.expires_at>clock_timestamp() and app.jsonb_references_artifact(snapshot.graph_json::jsonb,$2))
    or exists (select 1 from app.workflow_test_suite_cases entry join app.workflow_test_suites suite on suite.workspace_id=entry.workspace_id and suite.id=entry.suite_id
      where entry.workspace_id=$1 and suite.expires_at>clock_timestamp() and app.jsonb_references_artifact(entry.input::jsonb,$2))
    or exists (select 1 from app.workflow_drafts draft
      where draft.workspace_id = $1 and app.jsonb_references_artifact(draft.graph_json::jsonb, $2))
    or exists (select 1 from app.workflow_versions version
      where version.workspace_id = $1 and app.jsonb_references_artifact(version.graph_json::jsonb, $2))
    or exists (select 1 from app.workflow_input_case_payloads payload
      where payload.workspace_id=$1
        and app.jsonb_references_artifact(payload.input::jsonb, $2))
    or exists (select 1 from app.preview_runs preview
      where preview.workspace_id=$1 and preview.expires_at > clock_timestamp()
        and (app.jsonb_references_artifact(preview.input_ref::jsonb, $2)
          or app.jsonb_references_artifact(preview.executable_node_json::jsonb, $2)))
    or exists (select 1 from app.workflow_runs run
      where run.workspace_id = $1
        and (app.jsonb_references_artifact(run.input_ref::jsonb, $2)
          or app.jsonb_references_artifact(run.output_ref::jsonb, $2)))
    or exists (select 1 from app.node_runs node
      where node.workspace_id = $1
        and (app.jsonb_references_artifact(node.input_ref::jsonb, $2)
          or app.jsonb_references_artifact(node.output_ref::jsonb, $2)))
    or exists (select 1 from app.node_attempts attempt
      where attempt.workspace_id = $1
        and (app.jsonb_references_artifact(attempt.output_ref::jsonb, $2)
          or app.jsonb_references_artifact(attempt.reconciliation_ref, $2)))
    or exists (select 1 from app.run_events event
      where event.workspace_id = $1
        and app.jsonb_references_artifact(event.payload, $2))
    or exists (select 1 from app.run_checkpoints checkpoint
      where checkpoint.workspace_id = $1
        and app.jsonb_references_artifact(checkpoint.scheduler_state, $2))
    referenced`;
