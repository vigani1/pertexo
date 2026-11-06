import { withTenantScopedClient } from '@pertexo/database/primitives';
import { fixture, ownerTransaction, addVersion } from './lifetime.fixture.js';
import {
  workspaceId,
  userId,
  randomUUID,
} from '../lifecycle/retention.support.js';

export const ownerLocations = [
  'draft',
  'version',
  'snapshot',
  'suite-case',
  'input-case',
  'step-sample',
  'preview-input',
  'preview-output',
  'preview-node',
  'run-input',
  'run-output',
  'node-input',
  'node-output',
  'attempt-output',
  'attempt-reconciliation',
  'event',
  'checkpoint',
  'task-response',
] as const;
type OwnerLocation = (typeof ownerLocations)[number];

export async function artifactOwnerFixture(
  location: OwnerLocation,
  shape: 'business-id' | 'descriptor' | 'execution-reference',
) {
  const state = await fixture('literal', 'run-output');
  const close = async () => {
    try {
      await ownerTransaction((client) =>
        client.query(
          "update app.artifacts set expires_at=clock_timestamp()+interval '1 day' where workspace_id=$1 and id=$2",
          [workspaceId, state.reference.artifactId],
        ),
      );
    } finally {
      await state.close();
    }
  };
  try {
    const business = {
      nested: [
        shape === 'business-id'
          ? { artifactId: state.reference.artifactId }
          : state.reference,
      ],
    };
    const envelope =
      shape === 'execution-reference'
        ? { kind: 'artifact', artifactId: state.reference.artifactId }
        : { kind: 'inline', value: business };
    const graph = {
      ...state.graph,
      nodes: state.graph.nodes.map((node) => ({
        ...node,
        inputMappings: { payload: { kind: 'literal', value: business } },
      })),
    };
    await ownerTransaction((client) =>
      client.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active') on conflict do nothing",
        [workspaceId, userId],
      ),
    );
    await addVersion(state, location === 'version' ? graph : undefined);
    if (location === 'draft') {
      await ownerTransaction((client) =>
        client.query(
          'update app.workflow_drafts set graph_json=$3::json where workspace_id=$1 and workflow_id=$2',
          [workspaceId, state.workflowId, JSON.stringify(graph)],
        ),
      );
    } else if (location === 'input-case') {
      const caseId = randomUUID(),
        input = JSON.stringify(business);
      await ownerTransaction(async (client) => {
        await client.query(
          "insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name,revision) values($1,$2,$3,$4,$5,'Shape case',1)",
          [
            caseId,
            workspaceId,
            state.workflowId,
            state.versionId,
            'wf:sha256:' + 'a'.repeat(64),
          ],
        );
        await client.query(
          'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes) values($1,$2,1,$3,$4)',
          [workspaceId, caseId, input, Buffer.byteLength(input)],
        );
      });
    } else if (location === 'snapshot' || location === 'suite-case') {
      const snapshotId = randomUUID();
      await ownerTransaction(async (client) => {
        await client.query(
          "insert into app.workflow_test_snapshots(id,workflow_id,workspace_id,draft_revision,graph_json,checksum,executable_json,dispositions,pins,expires_at) values($1,$2,$3,1,$4::json,$5,'{}','{}','{}',clock_timestamp()+interval '1 day')",
          [
            snapshotId,
            state.workflowId,
            workspaceId,
            JSON.stringify(location === 'snapshot' ? graph : {}),
            'wf:sha256:' + 'a'.repeat(64),
          ],
        );
        if (location === 'suite-case') {
          const suiteId = randomUUID();
          await client.query(
            "insert into app.workflow_test_suites(id,workspace_id,workflow_id,started_by,snapshot_id,signature,uses_connections,case_duration_ms,initial_checkpoint,status,deadline_at,expires_at) values($1,$2,$3,$4,$5,repeat('a',64),false,1000,'{}','passed',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 day')",
            [suiteId, workspaceId, state.workflowId, userId, snapshotId],
          );
          await client.query(
            "insert into app.workflow_test_suite_cases(workspace_id,suite_id,ordinal,case_id,case_revision,name,input,expectations) values($1,$2,0,$3,1,'Shape case',$4,'{}')",
            [workspaceId, suiteId, randomUUID(), JSON.stringify(business)],
          );
        }
      });
    } else if (location === 'step-sample') {
      const output = JSON.stringify(envelope);
      await ownerTransaction((client) =>
        client.query(
          "insert into app.workflow_step_samples(id,workspace_id,workflow_id,node_id,binding,output_ref,retained_bytes,source_kind,created_by,expires_at) values($1,$2,$3,'file','binding',$4,$5,'json',$6,clock_timestamp()+interval '1 day')",
          [
            randomUUID(),
            workspaceId,
            state.workflowId,
            output,
            Buffer.byteLength(output) + 7,
            userId,
          ],
        ),
      );
    } else if (location.startsWith('preview-')) {
      await ownerTransaction((client) =>
        client.query(
          `insert into app.preview_runs(id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,definition_key,definition_version,executor_key,executor_version,actor_user_id,idempotency_key_hash,request_hash,executable_node_json,input_ref,output_ref,side_effect_class,may_contact_provider,may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at,status,completed_at,created_at,started_at)
      values($1,$2,$3,1,repeat('a',64),'file','core.set',1,'core.set',1,$4,repeat('b',64),repeat('c',64),$5::json,$6::json,$7::json,'safe',false,false,'not_supported',clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day',$8::varchar,case when $8::varchar='succeeded' then clock_timestamp() else null end,clock_timestamp()-interval '2 seconds',case when $8::varchar='succeeded' then clock_timestamp()-interval '1 second' else null end)`,
          [
            randomUUID(),
            workspaceId,
            state.workflowId,
            userId,
            JSON.stringify(
              location === 'preview-node' ? { config: business } : {},
            ),
            JSON.stringify(
              location === 'preview-input'
                ? envelope
                : { kind: 'inline', value: null },
            ),
            location === 'preview-output' ? JSON.stringify(envelope) : null,
            location === 'preview-output' ? 'succeeded' : 'queued',
          ],
        ),
      );
    } else if (location !== 'version') {
      await withTenantScopedClient(
        state.pool,
        { workspaceId },
        async (client) => {
          const runId = randomUUID(),
            nodeId = randomUUID();
          await client.query(
            "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at,input_ref,input_ref_expires_at,output_ref) values($1,$2,$3,$4,'manual','failed',clock_timestamp(),$5::json,clock_timestamp()+interval '1 day',$6::json)",
            [
              runId,
              workspaceId,
              state.workflowId,
              state.versionId,
              JSON.stringify(
                location === 'run-input'
                  ? envelope
                  : { kind: 'inline', value: null },
              ),
              location === 'run-output' ? JSON.stringify(envelope) : null,
            ],
          );
          if (location === 'event') {
            await client.query(
              "insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) values($1,$2,1,'node.succeeded',$3::jsonb)",
              [workspaceId, runId, JSON.stringify({ output: envelope })],
            );
          } else if (location === 'checkpoint') {
            await client.query(
              'insert into app.run_checkpoints(workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state) values($1,$2,$3,0,$4::jsonb)',
              [
                runId,
                workspaceId,
                state.versionId,
                JSON.stringify({ invocations: [{ output: envelope }] }),
              ],
            );
          } else if (!location.startsWith('run-')) {
            await client.query(
              "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,input_ref,output_ref) values($1,$2,$3,'file','file','succeeded','safe',$4::json,$5::json)",
              [
                nodeId,
                workspaceId,
                runId,
                location === 'node-input' ? JSON.stringify(envelope) : null,
                location === 'node-output' ? JSON.stringify(envelope) : null,
              ],
            );
            if (location.startsWith('attempt-'))
              await client.query(
                "insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref,reconciliation_ref) values($1,$2,$3,1,'succeeded','safe',$4::json,$5::jsonb)",
                [
                  randomUUID(),
                  workspaceId,
                  nodeId,
                  location === 'attempt-output'
                    ? JSON.stringify(envelope)
                    : null,
                  location === 'attempt-reconciliation'
                    ? JSON.stringify(envelope)
                    : null,
                ],
              );
            else if (location === 'task-response')
              await client.query(
                "insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,status,output_ref,decided_by,expires_at,completed_at) values($1,$2,$3,$4,$5,'file','input_request','{}','submitted',$6::json,$7,clock_timestamp()+interval '1 day',clock_timestamp())",
                [
                  randomUUID(),
                  workspaceId,
                  runId,
                  state.versionId,
                  nodeId,
                  JSON.stringify(envelope),
                  userId,
                ],
              );
          }
        },
      );
    }
    return { ...state, close };
  } catch (error) {
    await close();
    throw error;
  }
}
