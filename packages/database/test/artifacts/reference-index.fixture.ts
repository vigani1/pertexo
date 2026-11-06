import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { seedWorkflow } from '../platform/migrations/upgrade-fixture.js';

/** A populated pre-upgrade database: every owner, mixed-case IDs and incidental business data. */
export async function seedReferenceIndexOwners(admin: Pool) {
  const scope = await seedWorkflow(admin);
  const { workspaceId, workflowId, ownerId } = scope;
  const artifactId = randomUUID(),
    businessId = randomUUID();
  const versionId = randomUUID(),
    runId = randomUUID(),
    nodeId = randomUUID();
  const snapshotId = randomUUID(),
    suiteId = randomUUID(),
    caseId = randomUUID();
  const descriptor = {
    kind: 'artifact',
    artifactId: artifactId.toUpperCase(),
    byteLength: 4,
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
  };
  const business = { artifactId: businessId };
  const authored = { files: [descriptor, descriptor], business };
  const graph = JSON.stringify({
    nodes: [],
    edges: [],
    settings: {},
    retained: authored,
  });
  const envelope = JSON.stringify({ kind: 'inline', value: authored });
  await admin.query("select set_config('app.workspace_id',$1,false)", [
    workspaceId,
  ]);
  await admin.query(
    `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,finalized_at,expires_at)
    select id,$1,'node-output','workspaces/'||$1::uuid::text||'/artifacts/'||id::text,'text/plain',4,repeat('a',64),'available',clock_timestamp(),clock_timestamp()+interval '1 day' from unnest($2::uuid[]) id`,
    [workspaceId, [artifactId, businessId]],
  );
  await admin.query(
    'insert into app.workflow_drafts(workspace_id,workflow_id,revision,graph_json,updated_by) values($1,$2,1,$3::json,$4)',
    [workspaceId, workflowId, graph, ownerId],
  );
  await admin.query(
    "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,1,$4::json,$5,'{}',$6)",
    [
      versionId,
      workspaceId,
      workflowId,
      graph,
      'wf:sha256:' + 'a'.repeat(64),
      ownerId,
    ],
  );
  await admin.query(
    `insert into app.workflow_test_snapshots(id,workspace_id,workflow_id,draft_revision,graph_json,checksum,executable_json,dispositions,pins,expires_at)
    values($1,$2,$3,1,$4::json,$5,'{}','{}','{}',clock_timestamp()+interval '1 day')`,
    [snapshotId, workspaceId, workflowId, graph, 'wf:sha256:' + 'a'.repeat(64)],
  );
  await admin.query(
    `insert into app.workflow_test_suites(id,workspace_id,workflow_id,started_by,snapshot_id,signature,uses_connections,case_duration_ms,initial_checkpoint,status,deadline_at,expires_at)
    values($1,$2,$3,$4,$5,repeat('a',64),false,1000,'{}','passed',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 day')`,
    [suiteId, workspaceId, workflowId, ownerId, snapshotId],
  );
  await admin.query(
    "insert into app.workflow_test_suite_cases(workspace_id,suite_id,ordinal,case_id,case_revision,name,input,expectations) values($1,$2,0,$3,1,'Retained case',$4,'{}')",
    [workspaceId, suiteId, caseId, JSON.stringify(authored)],
  );
  await admin.query(
    "insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name,revision) values($1,$2,$3,$4,$5,'Retained input',1)",
    [caseId, workspaceId, workflowId, versionId, 'wf:sha256:' + 'a'.repeat(64)],
  );
  const input = JSON.stringify(authored);
  await admin.query(
    'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes) values($1,$2,1,$3,$4)',
    [workspaceId, caseId, input, Buffer.byteLength(input)],
  );
  await admin.query(
    `insert into app.workflow_step_samples(id,workspace_id,workflow_id,node_id,binding,output_ref,retained_bytes,source_kind,created_by,expires_at)
    values($1,$2,$3,'file','binding',$4,$5,'json',$6,clock_timestamp()+interval '1 day')`,
    [
      randomUUID(),
      workspaceId,
      workflowId,
      envelope,
      Buffer.byteLength(envelope) + 7,
      ownerId,
    ],
  );
  await admin.query(
    `insert into app.preview_runs(id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,definition_key,definition_version,executor_key,executor_version,actor_user_id,idempotency_key_hash,request_hash,executable_node_json,input_ref,output_ref,side_effect_class,may_contact_provider,may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at,status,started_at,completed_at,created_at)
    values($1,$2,$3,1,repeat('a',64),'file','core.set',1,'core.set',1,$4,repeat('b',64),repeat('c',64),$5::json,$6::json,$6::json,'safe',false,false,'not_supported',clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day','succeeded',clock_timestamp()-interval '1 second',clock_timestamp(),clock_timestamp()-interval '2 seconds')`,
    [randomUUID(), workspaceId, workflowId, ownerId, graph, envelope],
  );
  await admin.query(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at,input_ref,input_ref_expires_at,output_ref)
    values($1,$2,$3,$4,'manual','failed',clock_timestamp(),$5::json,clock_timestamp()+interval '1 day',$5::json)`,
    [runId, workspaceId, workflowId, versionId, envelope],
  );
  await admin.query(
    "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,input_ref,output_ref) values($1,$2,$3,'file','file','succeeded','safe',$4::json,$4::json)",
    [nodeId, workspaceId, runId, envelope],
  );
  await admin.query(
    "insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref,reconciliation_ref) values($1,$2,$3,1,'succeeded','safe',$4::json,$4::jsonb)",
    [randomUUID(), workspaceId, nodeId, envelope],
  );
  await admin.query(
    "insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) values($1,$2,1,'node.succeeded',$3::jsonb)",
    [
      workspaceId,
      runId,
      JSON.stringify({ output: JSON.parse(envelope) as unknown }),
    ],
  );
  await admin.query(
    'insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state) values($1,$2,$3,0,$4::jsonb)',
    [
      workspaceId,
      runId,
      versionId,
      JSON.stringify({
        invocations: [{ output: JSON.parse(envelope) as unknown }],
      }),
    ],
  );
  await admin.query(
    `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,status,output_ref,decided_by,expires_at,completed_at)
    values($1,$2,$3,$4,$5,'file','input_request','{}','submitted',$6::json,$7,clock_timestamp()+interval '1 day',clock_timestamp())`,
    [randomUUID(), workspaceId, runId, versionId, nodeId, envelope, ownerId],
  );
  // More than one backfill page, including documents with duplicate references.
  await admin.query(
    `with workflows as (insert into app.workflows(id,workspace_id,name,created_by)
    select gen_random_uuid(),$1,'Backfill '||n,$2 from generate_series(1,40)n returning id)
    insert into app.workflow_drafts(workspace_id,workflow_id,revision,graph_json,updated_by) select $1,id,1,$3::json,$2 from workflows`,
    [workspaceId, ownerId, graph],
  );
  return {
    ...scope,
    artifactId,
    businessId,
    descriptor,
    graph,
    runId,
    nodeId,
    caseId,
    suiteId,
  };
}
