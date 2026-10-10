import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../../src/config.js';
import { migrateDatabase } from '../../src/migrations.js';
import {
  createWorkspacePurgeCoordinator,
  PURGE_PRESERVED_TABLES,
  PURGE_STEPS,
} from '../../src/lifecycle/workspace-purge.js';
import { dropDisconnectedDatabase } from '../support/postgres/disposable-database.js';
import { enforceRetention } from '../support/retention.js';
import {
  emptyObjectStore,
  makeWorkspaceDueForPurge,
  purgeWorkspace,
} from '../support/workspace-purge.js';

const adminBaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_workspace_purge_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const adminUrl = withDatabase(adminBaseUrl);
const databaseUrl = withDatabase(migrationBaseUrl);
const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
let owner: Pool | undefined;

/** Holds each object page until released. */
class PausingObjectStore {
  public readonly started = Promise.withResolvers<undefined>();
  public readonly resume = Promise.withResolvers<undefined>();

  public async purgeWorkspacePage() {
    this.started.resolve(undefined);
    await this.resume.promise;
    return { completed: true, deletedCount: 0 };
  }
}

async function createWorkspace(): Promise<string> {
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

const coordinator = (objectStore = emptyObjectStore) =>
  createWorkspacePurgeCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    objectStore,
  );

beforeAll(async () => {
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
});

afterAll(async () => {
  await owner?.end();
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('workspace purge', () => {
  it('purges every workspace table, keeps scrubbed facts and leaves a tombstone', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
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
        await owner.query(
          `alter table app.${table} no force row level security`,
        );
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
      await owner.query(
        `insert into app.workflows(id,workspace_id,name,created_by)
         values($1,$2,'Purge dependency graph',$3)`,
        [workflowId, workspaceId, userId],
      );
      await owner.query(
        `insert into app.workflow_versions(
          id,workspace_id,workflow_id,version_number,schema_version,graph_json,
          checksum,executable_json,published_by,published_at
        ) values
          ($1,$3,$4,1,1,'{}',$5,'{}',$6,clock_timestamp()),
          ($2,$3,$4,2,1,'{}',$7,'{}',$6,clock_timestamp())`,
        [
          historicalVersionId,
          publishedVersionId,
          workspaceId,
          workflowId,
          `wf:v2:sha256:${'7'.repeat(64)}`,
          userId,
          `wf:v2:sha256:${'8'.repeat(64)}`,
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
          '{"kind":"inline","schemaVersion":1,"value":"input"}',
          clock_timestamp()+interval '1 day',
          '{"kind":"inline","schemaVersion":1,"value":"output"}',
          clock_timestamp(),clock_timestamp())`,
        [workflowRunId, workspaceId, workflowId, publishedVersionId],
      );
      await owner.query(
        `insert into app.node_runs(
          id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,input_ref,output_ref,
          started_at,completed_at
        ) values($1,$2,$3,'node-1','node-1','{}','succeeded','safe',
          '{"kind":"inline","schemaVersion":1,"value":"input"}',
          '{"kind":"inline","schemaVersion":1,"value":"output"}',
          clock_timestamp(),clock_timestamp())`,
        [nodeRunId, workspaceId, workflowRunId],
      );
      await owner.query(
        `insert into app.node_attempts(
          id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
          output_ref,started_at,completed_at
        ) values($1,$2,$3,1,'succeeded','safe',
          '{"kind":"inline","schemaVersion":1,"value":"output"}',
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
      for (const secretId of [firstSecretId, currentSecretId])
        await owner.query(
          `insert into app.connection_secret_versions(
            id,workspace_id,connection_id,schema_version,kms_key_reference,
            encrypted_data_key,ciphertext,nonce,auth_tag,created_by
          ) values($1,$2,$3,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
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
          '{"kind":"inline","schemaVersion":1,"value":null}'::jsonb,
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

    const steps = await purgeWorkspace({
      adminUrl,
      maintenanceUrl,
      workspaceId,
      pageSize: 1,
    });
    // Cycles go together, after everything that points at them.
    expect(steps).toContain('connections');
    expect(steps.indexOf('workflow_published_versions')).toBeLessThan(
      steps.indexOf('workflow_versions'),
    );

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const tombstone = await admin.query(
        'select status,name,slug,created_by,deletion_reason from app.workspaces where id=$1',
        [workspaceId],
      );
      expect(tombstone.rows[0]).toEqual({
        status: 'deleted',
        name: 'Deleted workspace',
        slug: `deleted-${workspaceId}`,
        created_by: null,
        deletion_reason: 'purged',
      });
      const residue = await admin.query<Record<string, string>>(
        `select
          (select count(*) from app.workspace_memberships where workspace_id=$1) membership_count,
          (select count(*) from app.workspace_invitation_binding_replacement_claims
            where prior_workspace_id=$1 or successor_workspace_id=$1) replacement_claim_count,
          (select count(*) from app.artifacts where workspace_id=$1) artifact_count,
          (select count(*) from app.audit_events where workspace_id=$1 and
            (actor_user_id is not null or request_id is not null or trace_id is not null
             or metadata<>'{}'::jsonb or target_id is distinct from $1)) audit_sensitive,
          (select count(*) from app.usage_events where workspace_id=$1 and
            (metadata<>'{}'::jsonb or resource_id<>$1
             or resource_type<>'workspace-tombstone' or idempotency_key<>id::text)) usage_sensitive,
          (select count(*) from app.transport_security_audit_facts where workspace_id=$1
            and (consumer_name<>'purged' or message_id<>id)) security_sensitive`,
        [workspaceId],
      );
      // A claim still live in another workspace waits for its own reaper.
      expect(residue.rows[0]).toEqual({
        audit_sensitive: '0',
        artifact_count: '0',
        membership_count: '0',
        replacement_claim_count: '1',
        security_sensitive: '0',
        usage_sensitive: '0',
      });
      await admin.query(
        `update app.workspace_invitation_acceptance_intents
            set status='superseded',updated_at=clock_timestamp()
          where id=$1`,
        [externalIntentId],
      );
      await enforceRetention(maintenanceUrl);
      const claims = await admin.query<{ count: string }>(
        `select count(*) from app.workspace_invitation_binding_replacement_claims
         where prior_workspace_id = $1 or successor_workspace_id = $1`,
        [workspaceId],
      );
      expect(claims.rows[0]?.count).toBe('0');
    } finally {
      await admin.end();
    }
  });

  it('names every workspace table as purged or kept', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
    const tables = await owner.query<{ name: string }>(
      `select distinct table_class.relname as name
       from pg_attribute attribute
       join pg_class table_class on table_class.oid = attribute.attrelid
       join pg_namespace namespace on namespace.oid = table_class.relnamespace
       where namespace.nspname = 'app' and table_class.relkind = 'r'
         and attribute.attname = 'workspace_id' and not attribute.attisdropped
       order by 1`,
    );
    const covered = new Set([
      ...PURGE_STEPS.map(({ name }) => name),
      ...PURGE_PRESERVED_TABLES,
    ]);
    expect(
      tables.rows.map(({ name }) => name).filter((name) => !covered.has(name)),
    ).toEqual([]);
  });

  it('waits for the recovery period before purging', async () => {
    const workspaceId = await createWorkspace();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `update app.workspaces
         set status='pending_deletion', deletion_requested_at=clock_timestamp(),
             deletion_requested_by=created_by, deletion_reason='Not yet',
             purge_after=clock_timestamp()+interval '1 day'
         where id=$1`,
        [workspaceId],
      );
    } finally {
      await admin.end();
    }
    const purge = coordinator();
    try {
      for (let call = 0; call < 5; call += 1) {
        const result = await purge.processNext();
        expect(
          result.status === 'idle' || result.workspaceId !== workspaceId,
        ).toBe(true);
      }
    } finally {
      await purge.close();
    }
  });

  it('starts one purge when workers race', async () => {
    const workspaceId = await createWorkspace();
    await makeWorkspaceDueForPurge(adminUrl, workspaceId);
    const workers = [coordinator(), coordinator(), coordinator()];
    try {
      const results = await Promise.all(
        workers.map((worker) => worker.processNext()),
      );
      expect(
        results.filter(
          (result) =>
            result.status === 'started' && result.workspaceId === workspaceId,
        ),
      ).toHaveLength(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
    await purgeWorkspace({ adminUrl, maintenanceUrl, workspaceId });
  });

  it('holds no transaction or workspace lock while objects are erased', async () => {
    const workspaceId = await createWorkspace();
    await makeWorkspaceDueForPurge(adminUrl, workspaceId);
    const objectStore = new PausingObjectStore();
    const purge = coordinator(objectStore);
    try {
      let reachedObjects: Promise<unknown> | undefined;
      for (let call = 0; call < 50 && reachedObjects === undefined; call += 1) {
        const next = purge.processNext();
        const outcome = await Promise.race([
          next,
          objectStore.started.promise.then(() => 'objects' as const),
        ]);
        if (outcome === 'objects') reachedObjects = next;
      }
      expect(reachedObjects).toBeDefined();
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        const activity = await admin.query<{ count: string }>(
          `select count(*)::text count from pg_stat_activity
           where datname=$1 and usename='pertexo_maintenance'
             and xact_start is not null`,
          [databaseName],
        );
        expect(activity.rows[0]?.count).toBe('0');
        await admin.query('begin');
        await expect(
          admin.query(
            'select 1 from app.workspaces where id=$1 for update nowait',
            [workspaceId],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
        await admin.query('rollback');
      } finally {
        await admin.end();
        objectStore.resume.resolve(undefined);
      }
      await expect(reachedObjects).resolves.toMatchObject({
        status: 'completed',
        workspaceId,
      });
    } finally {
      objectStore.resume.resolve(undefined);
      await purge.close();
    }
  });
});
