import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';

import { parseDatabaseConfig } from '../../../src/config.js';
import { migrateDatabase } from '../../../src/migrations.js';
import { createWorkspacePurgeCoordinator } from '../../../src/lifecycle/workspace-purge.js';
import { dropDisconnectedDatabase } from '../../support/postgres/disposable-database.js';

import { emptyObjectStore } from '../../support/workspace-purge.js';

const adminBaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const databaseName = `pertexo_test_workspace_purge_${randomUUID().replaceAll('-', '')}`;

const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

export const adminUrl = withDatabase(adminBaseUrl);

const databaseUrl = withDatabase(migrationBaseUrl);

export const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);

export let owner: Pool | undefined;

/** Holds each object page until released. */
export class PausingObjectStore {
  public readonly started = Promise.withResolvers<undefined>();
  public readonly resume = Promise.withResolvers<undefined>();

  public async purgeWorkspacePage() {
    this.started.resolve(undefined);
    await this.resume.promise;
    return { completed: true, deletedCount: 0 };
  }
}

export async function createWorkspace(): Promise<string> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Purge owner')",
      [userId, `${userId}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge fixture',$2,$3)",
      [workspaceId, `purge-${workspaceId}`, userId],
    );
  } finally {
    await admin.end();
  }
  return workspaceId;
}

export const coordinator = (objectStore = emptyObjectStore) =>
  createWorkspacePurgeCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    objectStore,
  );

export async function beforeAllFixture1() {
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_app`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    connectionString: databaseUrl,
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  owner = new Pool({ connectionString: databaseUrl, max: 1 });
}

export async function afterAllFixture2() {
  await owner?.end();
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
}

function createPurgeSeed() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const artifactId = randomUUID();
  const workflowId = randomUUID();
  const publishedVersionId = randomUUID();
  const historicalVersionId = randomUUID();
  const workflowRunId = randomUUID();
  const nodeRunId = randomUUID();
  const nodeAttemptId = randomUUID();
  const connectionId = randomUUID();
  const firstSecretId = randomUUID();
  const currentSecretId = randomUUID();
  const destinationId = randomUUID();
  const previewRunId = randomUUID();
  const previewAttemptId = randomUUID();
  const replacementPriorIntentId = randomUUID();
  const replacementSuccessorIntentId = randomUUID();
  const externalWorkspaceId = randomUUID();
  const externalInvitationId = randomUUID();
  const externalIntentId = randomUUID();
  const externalClaimPriorIntentId = randomUUID();
  const incomingClaimPriorIntentId = randomUUID();

  return {
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
    replacementPriorIntentId,
    replacementSuccessorIntentId,
    externalWorkspaceId,
    externalInvitationId,
    externalIntentId,
    externalClaimPriorIntentId,
    incomingClaimPriorIntentId,
  };
}

type PurgeSeed = ReturnType<typeof createPurgeSeed>;

export async function seedPurgeScenario(owner: Pool): Promise<PurgeSeed> {
  const ids = createPurgeSeed();
  const { workspaceId } = ids;
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    for (const table of [
      'workflow_runs',
      'node_runs',
      'node_attempts',
      'preview_runs',
      'preview_attempts',
      'artifact_links',
    ])
      await owner.query(`alter table app.${table} no force row level security`);
    await seedPurgeRelationships(owner, ids);
    await seedPurgeEvidence(owner, ids);
    await seedPurgeExecution(owner, ids);
    await owner.query('set constraints all immediate');
    for (const table of [
      'workflow_runs',
      'node_runs',
      'node_attempts',
      'preview_runs',
      'preview_attempts',
      'artifact_links',
    ])
      await owner.query(`alter table app.${table} force row level security`);
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback');
    throw error;
  }

  return ids;
}

async function seedPurgeRelationships(
  owner: Pool,
  ids: PurgeSeed,
): Promise<void> {
  const {
    workspaceId,
    userId,
    replacementPriorIntentId,
    replacementSuccessorIntentId,
    externalWorkspaceId,
    externalInvitationId,
    externalIntentId,
    externalClaimPriorIntentId,
    incomingClaimPriorIntentId,
  } = ids;
  await owner.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Purge owner')",
    [userId, `${userId}@example.test`],
  );
  await owner.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge fixture',$2,$3)",
    [workspaceId, `purge-${workspaceId}`, userId],
  );
  await owner.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')",
    [workspaceId, userId],
  );
  await owner.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge external successor',$2,$3)",
    [externalWorkspaceId, `purge-external-${externalWorkspaceId}`, userId],
  );
  await owner.query(
    `insert into app.workspace_invitations
          (id,workspace_id,recipient_email,normalized_email,role,status,revision,
           token_digest,delivery_status,created_by,expires_at)
         values($1,$2,$3,$3,'viewer','pending',1,$4,'submitted',$5,
           clock_timestamp()+interval '1 day')`,
    [
      externalInvitationId,
      externalWorkspaceId,
      `${externalInvitationId}@example.test`,
      'd'.repeat(64),
      userId,
    ],
  );
  await owner.query(
    `insert into app.workspace_invitation_acceptance_intents
          (id,workspace_id,invitation_id,invitation_revision,binding_digest,
           csrf_digest,status,expires_at)
         values($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '10 minutes')`,
    [
      externalIntentId,
      externalWorkspaceId,
      externalInvitationId,
      'e'.repeat(64),
      'f'.repeat(64),
    ],
  );
  await owner.query(
    `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$1,$4,$5,1,$6,$7)`,
    [
      workspaceId,
      replacementPriorIntentId,
      'a'.repeat(64),
      replacementSuccessorIntentId,
      randomUUID(),
      'b'.repeat(64),
      'c'.repeat(64),
    ],
  );
  for (let ordinal = 1; ordinal <= 10; ordinal += 1)
    await owner.query(
      `insert into app.workspace_invitation_binding_replacement_claims
            (prior_workspace_id,prior_intent_id,prior_binding_digest,
             successor_workspace_id,successor_intent_id,successor_invitation_id,
             successor_invitation_revision,successor_binding_digest,
             successor_csrf_digest,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,1,$7,$8,
             timestamptz '2025-01-01 00:00:00+00'+$9*interval '1 second',
             timestamptz '2025-01-01 00:00:00+00'+$9*interval '1 second')`,
      [
        workspaceId,
        randomUUID(),
        ordinal.toString(16).padStart(64, '0'),
        externalWorkspaceId,
        randomUUID(),
        randomUUID(),
        (ordinal + 16).toString(16).padStart(64, '0'),
        (ordinal + 32).toString(16).padStart(64, '0'),
        ordinal,
      ],
    );
  await owner.query(
    `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$4,$5,$6,1,$7,$8)`,
    [
      workspaceId,
      externalClaimPriorIntentId,
      '1'.repeat(64),
      externalWorkspaceId,
      externalIntentId,
      externalInvitationId,
      'e'.repeat(64),
      'f'.repeat(64),
    ],
  );
  await owner.query(
    `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$4,$5,$6,1,$7,$8)`,
    [
      externalWorkspaceId,
      incomingClaimPriorIntentId,
      '4'.repeat(64),
      workspaceId,
      randomUUID(),
      randomUUID(),
      '5'.repeat(64),
      '6'.repeat(64),
    ],
  );
}

async function seedPurgeEvidence(owner: Pool, ids: PurgeSeed): Promise<void> {
  const { workspaceId, userId, artifactId, workflowId } = ids;
  await owner.query(
    `insert into app.audit_events
          (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
         values($1,$2,$3,'workspace.fixture','workspace',$3,'request-secret','trace-secret',$4)`,
    [randomUUID(), workspaceId, userId, { tenant: 'secret' }],
  );
  const usageId = randomUUID();
  await owner.query(
    `insert into app.usage_events
          (id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata)
         values($1,$2,'preview.execution',1,'preview-run',$3,$4,$5)`,
    [
      usageId,
      workspaceId,
      randomUUID(),
      `usage-${usageId}`,
      { tenant: 'secret' },
    ],
  );
  const skipId = randomUUID();
  await owner.query(
    `insert into app.usage_events
          (id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata)
         values($1::uuid,$2,'trigger.skipped',1,'workflow',$3,$1::text,
           '{"triggerType":"webhook","reason":"concurrency_limit"}')`,
    [skipId, workspaceId, workflowId],
  );
  const securityFactId = randomUUID();
  await owner.query(
    `insert into app.transport_security_audit_facts
          (id,workspace_id,fact_type,consumer_name,message_id)
         values($1,$2,'inbox_checksum_mismatch','worker.fixture',$3)`,
    [securityFactId, workspaceId, randomUUID()],
  );
  await owner.query(
    `insert into app.artifacts
          (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,expires_at)
         values($1::uuid,$2::uuid,'output','workspaces/'||$2::text||'/artifacts/'||$1::text,
          'application/json',2,$3,clock_timestamp()+interval '1 day')`,
    [artifactId, workspaceId, '9'.repeat(64)],
  );
}

async function seedPurgeExecution(owner: Pool, ids: PurgeSeed): Promise<void> {
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
