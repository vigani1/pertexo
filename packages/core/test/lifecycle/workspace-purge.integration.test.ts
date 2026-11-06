import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  adminUrl,
  maintenanceUrl,
  createWorkspace,
  owner,
  seedPurgeScenario,
  databaseName,
  PausingObjectStore,
  coordinator,
} from './workspace-purge/fixture.js';
import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';
import {
  purgeWorkspace,
  makeWorkspaceDueForPurge,
} from '../support/workspace-purge.js';
import { enforceRetention } from '../support/retention.js';
import {
  PURGE_PRESERVED_TABLES,
  PURGE_STEPS,
} from '../../src/lifecycle/purge/steps.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('workspace purge', () => {
  it('removes directory-managed grants in other linked workspaces before deleting the control organization', async () => {
    const control = await createWorkspace(),
      linked = await createWorkspace();
    const inspector = new Pool({ connectionString: adminUrl, max: 1 });
    const organizationId = randomUUID(),
      directoryId = randomUUID(),
      managedId = randomUUID(),
      manualId = randomUUID();
    try {
      await inspector.query(
        "insert into app.users(id,email,email_verified,display_name,status) values($1,$1::uuid::text||'@purge.test',true,'Managed','active'),($2,$2::uuid::text||'@purge.test',true,'Manual','active')",
        [managedId, manualId],
      );
      await inspector.query(
        "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Directory purge')",
        [organizationId, control],
      );
      await inspector.query(
        'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$3),($2,$3)',
        [control, linked, organizationId],
      );
      await inspector.query(
        `insert into app.auth_directory_users(id,organization_id,user_id,user_name,normalized_user_name,login_email,profile)
        values($1,$2,$3,'managed','managed',$3::uuid::text||'@purge.test','{"emails":[{"value":"managed@purge.test","primary":true}]}')`,
        [directoryId, organizationId, managedId],
      );
      await inspector.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$3,'builder','active'),($2,$3,'builder','active'),($2,$4,'operator','active')",
        [control, linked, managedId, manualId],
      );
      await inspector.query(
        'insert into app.auth_directory_memberships(organization_id,workspace_id,user_id,directory_user_id) values($1,$2,$4,$5),($1,$3,$4,$5)',
        [organizationId, control, linked, managedId, directoryId],
      );
      await inspector.query(
        "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$1::uuid::text,clock_timestamp()+interval '1 hour')",
        [randomUUID(), managedId],
      );
      await inspector.query(
        "insert into app.notice_preferences(workspace_id,user_id,mode) values($1,$2,'immediate')",
        [linked, managedId],
      );
      await purgeWorkspace({
        adminUrl,
        maintenanceUrl,
        workspaceId: control,
        pageSize: 1,
      });
      expect(
        (
          await inspector.query(
            'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
            [linked, managedId],
          )
        ).rows,
      ).toEqual([{ role: 'builder', status: 'removed', role_revision: 2 }]);
      expect(
        (
          await inspector.query(
            'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
            [linked, manualId],
          )
        ).rows,
      ).toEqual([{ role: 'operator', status: 'active' }]);
      expect(
        (
          await inspector.query(
            'select id from app.auth_organizations where id=$1',
            [organizationId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inspector.query(
            'select user_id from app.auth_directory_memberships where organization_id=$1',
            [organizationId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inspector.query(
            'select id from app.auth_sessions where user_id=$1',
            [managedId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inspector.query(
            'select user_id from app.notice_preferences where workspace_id=$1 and user_id=$2',
            [linked, managedId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await inspector.end();
    }
  });

  it.each(['oidc', 'saml'] as const)(
    'purges %s organization identities in bounded pages without removing ordinary credentials or another workspace',
    async (kind) => {
      const workspaceId = await createWorkspace(),
        otherWorkspaceId = await createWorkspace();
      const inspector = new Pool({ connectionString: adminUrl, max: 1 });
      const organizationId = randomUUID(),
        providerId = randomUUID(),
        accountId = randomUUID();
      try {
        const user = (
          await inspector.query<{ created_by: string }>(
            'select created_by from app.workspaces where id=$1',
            [workspaceId],
          )
        ).rows[0];
        if (user === undefined) throw new Error('Purge user missing');
        await inspector.query(
          "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Purge organization')",
          [organizationId, workspaceId],
        );
        await inspector.query(
          'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$3),($2,$3)',
          [workspaceId, otherWorkspaceId, organizationId],
        );
        await inspector.query(
          "insert into app.auth_providers(id,organization_id,kind,name,issuer,configuration,sealed_secret,enabled) values($1,$2,$3,'Purge provider','https://idp.example.test','{}',case when $3='oidc' then '{}'::jsonb else null end,true)",
          [providerId, organizationId, kind],
        );
        await inspector.query(
          "insert into app.auth_accounts(id,user_id,provider_id,account_id,password) values($1,$2::uuid,'credential',$2::text,'kept-password-hash'),($3,$2::uuid,$4,'provider-subject',null)",
          [accountId, user.created_by, randomUUID(), providerId],
        );
        await inspector.query(
          "insert into app.auth_sessions(id,user_id,token,expires_at,authentication_method,federation_provider_id,federation_provider_revision) values($1,$2,$3,clock_timestamp()+interval '1 hour','organization',$4,1)",
          [randomUUID(), user.created_by, randomUUID(), providerId],
        );
        const maintenance = new Pool({
          connectionString: maintenanceUrl,
          max: 1,
        });
        try {
          expect(
            (
              await maintenance.query(
                'select id,provider_id from app.auth_accounts where id=$1',
                [accountId],
              )
            ).rowCount,
          ).toBe(1);
          await expect(
            maintenance.query(
              'select password from app.auth_accounts where id=$1',
              [accountId],
            ),
          ).rejects.toHaveProperty('code', '42501');
        } finally {
          await maintenance.end();
        }
        await purgeWorkspace({
          adminUrl,
          maintenanceUrl,
          workspaceId,
          pageSize: 1,
        });
        expect(
          (
            await inspector.query(
              'select id from app.auth_organizations where id=$1',
              [organizationId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await inspector.query(
              'select id from app.auth_sessions where federation_provider_id=$1',
              [providerId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await inspector.query(
              'select provider_id from app.auth_accounts where user_id=$1',
              [user.created_by],
            )
          ).rows,
        ).toEqual([{ provider_id: 'credential' }]);
        expect(
          (
            await inspector.query(
              'select status from app.workspaces where id=$1',
              [otherWorkspaceId],
            )
          ).rows,
        ).toEqual([{ status: 'active' }]);
      } finally {
        await inspector.end();
      }
    },
  );

  it('purges every workspace table, keeps scrubbed facts and leaves a tombstone', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
    const { workspaceId, externalIntentId } = await seedPurgeScenario(owner);

    const steps = await purgeWorkspace({
      adminUrl,
      maintenanceUrl,
      workspaceId,
      pageSize: 1,
    });
    // Cycles go together, after everything that points at them.
    expect(steps).toContain('connections');
    expect(steps).toContain('connection_shares');
    expect(steps).toContain('connection_oauth2_tokens');
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
          (select count(*) from app.connection_oauth2_clients where workspace_id=$1)
            + (select count(*) from app.connection_oauth2_tokens where workspace_id=$1)
            + (select count(*) from app.connection_oauth2_authorizations where workspace_id=$1) oauth2_count,
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
        oauth2_count: '0',
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
  }, 30_000);

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

  it('purges replay and recovery descendants across pages and a coordinator restart', async () => {
    if (owner === undefined) throw new Error('Fixture not initialized');
    const ids = await seedPurgeScenario(owner);
    const untouched = await seedPurgeScenario(owner);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    let worker = coordinator();
    try {
      await admin.query("select set_config('app.workspace_id',$1,false)", [
        ids.workspaceId,
      ]);
      await admin.query(
        `insert into app.workflow_runs(
          id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
          replay_source_run_id,replay_command_id,completed_at)
         select uuidv7(),$1,$2,$3,'replay','succeeded',$4,uuidv7(),clock_timestamp()
         from generate_series(1,501)`,
        [
          ids.workspaceId,
          ids.workflowId,
          ids.publishedVersionId,
          ids.workflowRunId,
        ],
      );
      const replay = await admin.query<{ id: string }>(
        'select id from app.workflow_runs where replay_source_run_id=$1 limit 1',
        [ids.workflowRunId],
      );
      await admin.query(
        `insert into app.workflow_runs(
          id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
          replay_source_run_id,replay_command_id,completed_at,
          recovery_target_node_run_id,recovery_target_node_id,recovery_reused_count,
          recovery_effect_risk,recovery_effects_acknowledged)
         values(uuidv7(),$1,$2,$3,'replay','succeeded',$4,uuidv7(),clock_timestamp(),
          $5,'node-1',1,'ordinary',false)`,
        [
          ids.workspaceId,
          ids.workflowId,
          ids.publishedVersionId,
          replay.rows[0]?.id,
          ids.nodeRunId,
        ],
      );
      const beforeOther = await admin.query(
        'select * from app.workflow_runs where workspace_id=$1 order by id',
        [untouched.workspaceId],
      );
      await makeWorkspaceDueForPurge(adminUrl, ids.workspaceId);
      let restarted = false;
      let completed = false;
      for (let call = 0; call < 200; call += 1) {
        const result = await worker.processNext();
        if (
          result.status === 'progressed' &&
          result.step === 'workflow_runs' &&
          !restarted
        ) {
          const remaining = await admin.query<{ count: number }>(
            'select count(*)::int count from app.workflow_runs where workspace_id=$1',
            [ids.workspaceId],
          );
          expect(remaining.rows[0]?.count).toBeGreaterThan(0);
          expect(remaining.rows[0]?.count).toBeLessThan(503);
          await worker.close();
          worker = coordinator();
          restarted = true;
        }
        if (
          result.status === 'completed' &&
          result.workspaceId === ids.workspaceId
        ) {
          completed = true;
          break;
        }
      }
      expect(
        (
          await admin.query(
            'select * from app.workflow_runs where workspace_id=$1 order by id',
            [untouched.workspaceId],
          )
        ).rows,
      ).toEqual(beforeOther.rows);
      expect(restarted).toBe(true);
      expect(completed).toBe(true);
      expect(
        (
          await admin.query('select status from app.workspaces where id=$1', [
            ids.workspaceId,
          ])
        ).rows,
      ).toEqual([{ status: 'deleted' }]);
      expect(
        (
          await admin.query(
            'select id from app.workflow_runs where workspace_id=$1',
            [ids.workspaceId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await worker.close();
      await admin.end();
    }
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

  it('refuses a tombstone while an unlisted workspace table still holds rows', async () => {
    const workspaceId = await createWorkspace();
    await makeWorkspaceDueForPurge(adminUrl, workspaceId);
    const purge = coordinator();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        'create table app.purge_guard_probe (workspace_id uuid not null)',
      );
      await admin.query(
        'grant select on app.purge_guard_probe to pertexo_maintenance',
      );
      await admin.query(
        'insert into app.purge_guard_probe(workspace_id) values($1)',
        [workspaceId],
      );
      const finish = async () => {
        for (let call = 0; call < 100; call += 1) {
          const result = await purge.processNext();
          if (
            result.status === 'completed' &&
            result.workspaceId === workspaceId
          )
            return;
        }
        throw new Error('Purge did not reach its completion proof');
      };
      await expect(finish()).rejects.toThrow(
        'Workspace purge left rows in purge_guard_probe',
      );
      const stored = await admin.query(
        'select status from app.workspaces where id=$1',
        [workspaceId],
      );
      expect(stored.rows).toEqual([{ status: 'purging' }]);
    } finally {
      try {
        await admin.query('drop table if exists app.purge_guard_probe');
      } finally {
        await Promise.all([admin.end(), purge.close()]);
      }
      await purgeWorkspace({ adminUrl, maintenanceUrl, workspaceId });
    }
  });
});
