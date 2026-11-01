import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { PurgeSeed } from '../base.js';

export async function seedPurgeExecution(
  owner: Pool,
  ids: PurgeSeed,
): Promise<void> {
  const {
    workspaceId,
    userId,
    artifactId,
    workflowId,
    publishedVersionId,
    historicalVersionId,
    workflowRunId,
    nodeRunId,
    nodeAttemptId,
    connectionId,
    firstSecretId,
    currentSecretId,
    destinationId,
    previewRunId,
    previewAttemptId,
  } = ids;
  await owner.query(
    `insert into app.workflows(id,workspace_id,name,created_by)
         values($1,$2,'Purge dependency graph',$3)`,
    [workflowId, workspaceId, userId],
  );
  await owner.query(
    `insert into app.workflow_versions(
          id,workspace_id,workflow_id,version_number,graph_json,
          checksum,executable_json,published_by,published_at
        ) values
          ($1,$3,$4,1,'{}',$5,'{}',$6,clock_timestamp()),
          ($2,$3,$4,2,'{}',$7,'{}',$6,clock_timestamp())`,
    [
      historicalVersionId,
      publishedVersionId,
      workspaceId,
      workflowId,
      `wf:sha256:${'7'.repeat(64)}`,
      userId,
      `wf:sha256:${'8'.repeat(64)}`,
    ],
  );
  await owner.query(
    `update app.workflows
            set published_version_id=$2,activation_status='active'
          where id=$1`,
    [workflowId, publishedVersionId],
  );
  await owner.query(
    `insert into app.workflow_runs(
          id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
          input_ref,input_ref_expires_at,output_ref,started_at,completed_at
        ) values($1,$2,$3,$4,'manual','succeeded',
          '{"kind":"inline","value":"input"}',
          clock_timestamp()+interval '1 day',
          '{"kind":"inline","value":"output"}',
          clock_timestamp(),clock_timestamp())`,
    [workflowRunId, workspaceId, workflowId, publishedVersionId],
  );
  await owner.query(
    `insert into app.node_runs(
          id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,input_ref,output_ref,
          started_at,completed_at
        ) values($1,$2,$3,'node-1','node-1','{}','succeeded','safe',
          '{"kind":"inline","value":"input"}',
          '{"kind":"inline","value":"output"}',
          clock_timestamp(),clock_timestamp())`,
    [nodeRunId, workspaceId, workflowRunId],
  );
  await owner.query(
    `insert into app.node_attempts(
          id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
          output_ref,started_at,completed_at
        ) values($1,$2,$3,1,'succeeded','safe',
          '{"kind":"inline","value":"output"}',
          clock_timestamp(),clock_timestamp())`,
    [nodeAttemptId, workspaceId, nodeRunId],
  );
  await owner.query(
    `update app.node_runs
            set current_attempt_id=$2,current_attempt_number=1
          where id=$1`,
    [nodeRunId, nodeAttemptId],
  );
  await owner.query(
    `insert into app.connections(
          id,workspace_id,provider_key,name,auth_type,status,
          current_secret_version_id,created_by
        ) values($1,$2,'email','Purge email','resend_api_key','active',$3,$4)`,
    [connectionId, workspaceId, firstSecretId, userId],
  );
  await owner.query(
    'insert into app.connection_shares(workspace_id,connection_id,user_id) values($1,$2,$3)',
    [workspaceId, connectionId, userId],
  );
  for (const secretId of [firstSecretId, currentSecretId])
    await owner.query(
      `insert into app.connection_secret_versions(
            id,workspace_id,connection_id,kms_key_reference,
            encrypted_data_key,ciphertext,nonce,auth_tag,created_by
          ) values($1,$2,$3,'kms','key','cipher','AAAAAAAAAAAAAAAA',
            'AAAAAAAAAAAAAAAAAAAAAA',$4)`,
      [secretId, workspaceId, connectionId, userId],
    );
  await owner.query(
    "update app.connections set current_secret_version_id=$2,health_revision=health_revision+1,last_health_transition_at=clock_timestamp(),last_health_transition_source='rotation' where id=$1",
    [connectionId, currentSecretId],
  );
  await owner.query(
    `insert into app.connection_oauth2_clients(
          workspace_id,connection_id,secret_version_id,settings
        ) values($1,$2,$3,'{}')`,
    [workspaceId, connectionId, currentSecretId],
  );
  await owner.query(
    `insert into app.connection_oauth2_tokens(
          id,workspace_id,connection_id,secret_version_id,kms_key_reference,
          encrypted_data_key,ciphertext,nonce,auth_tag,authorized_at,issued_at,
          renewable
        ) values($1,$2,$3,$4,'kms','key','cipher','AAAAAAAAAAAAAAAA',
          'AAAAAAAAAAAAAAAAAAAAAA',clock_timestamp(),clock_timestamp(),true)`,
    [randomUUID(), workspaceId, connectionId, currentSecretId],
  );
  await owner.query(
    `insert into app.connection_oauth2_authorizations(
          workspace_id,connection_id,state_digest,binding_digest,started_by,
          secret_version_id,expires_at
        ) values($1,$2,$3,$4,$5,$6,clock_timestamp() + interval '10 minutes')`,
    [
      workspaceId,
      connectionId,
      randomBytes(32),
      randomBytes(32),
      userId,
      currentSecretId,
    ],
  );
  await owner.query(
    `insert into app.failure_notification_destinations(
          id,workspace_id,kind,status,current_config_version,created_by
        ) values($1,$2,'email','enabled',1,$3)`,
    [destinationId, workspaceId, userId],
  );
  for (const version of [1, 2])
    await owner.query(
      `insert into app.failure_notification_destination_versions(
            workspace_id,destination_id,version,kind,side_effect_class,config,
            created_by
          ) values($1,$2,$3,'email','idempotent_with_key',$4::jsonb,$5)`,
      [
        workspaceId,
        destinationId,
        version,
        JSON.stringify({
          connectionId,
          toEmail: `purge-${String(version)}@example.test`,
        }),
        userId,
      ],
    );
  await owner.query(
    `update app.failure_notification_destinations
            set current_config_version=2 where id=$1`,
    [destinationId],
  );
  await owner.query(
    `insert into app.preview_runs(
          id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,
          definition_key,definition_version,executor_key,executor_version,
          actor_user_id,idempotency_key_hash,request_hash,executable_node_json,
          input_ref,side_effect_class,may_contact_provider,
          may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at
        )
        select $1,$2,$3,1,$4,'node-1','core.set',1,'core.set',1,
          $5,$6,$7,
          '{"id":"node-1","type":"core.set"}'::jsonb,
          '{"kind":"inline","value":null}'::jsonb,
          'safe',false,false,'not_supported',
          clock_timestamp()+interval '1 hour',
          clock_timestamp()+interval '2 days'`,
    [
      previewRunId,
      workspaceId,
      workflowId,
      'a'.repeat(64),
      userId,
      'b'.repeat(64),
      'c'.repeat(64),
    ],
  );
  await owner.query(
    `insert into app.preview_attempts(
          id,workspace_id,preview_run_id,status,side_effect_class
        ) values($1,$2,$3,'queued','safe')`,
    [previewAttemptId, workspaceId, previewRunId],
  );
  await owner.query(
    `insert into app.artifact_links(
          workspace_id,artifact_id,owner_kind,owner_id
        ) values($1,$2,'preview_run',$3)`,
    [workspaceId, artifactId, previewRunId],
  );
  await owner.query(
    `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{"RATE":10}'),($1,2,'{"RATE":20}')`,
    [workspaceId],
  );
  await owner.query(
    'insert into app.workspace_variables(workspace_id,revision) values($1,2)',
    [workspaceId],
  );
  await owner.query(
    'update app.workflow_runs set variable_set_revision=1 where id=$1',
    [workflowRunId],
  );
  await owner.query(
    'update app.preview_runs set variable_set_revision=1 where id=$1',
    [previewRunId],
  );
}
