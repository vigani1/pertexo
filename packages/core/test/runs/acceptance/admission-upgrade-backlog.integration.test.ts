import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  canonicalOutboxPayloadChecksum,
  createDisposableDatabaseFixture,
  MIGRATIONS_DIRECTORY,
  migrateDatabase,
} from '@pertexo/database/testing';
import { claimOutboxBatch } from '../../../src/outbox/dispatcher/claim.js';

const WORKSPACE_LIMIT = 3;
const WORKFLOW_LIMIT = 2;
const QUEUED_PER_WORKFLOW = 6;

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

it('keeps admitting a queued backlog in order and within limits after upgrading from v0.2.0 plus 0001', async () => {
  await withV020Plus0001(async ({ admin, upgrade, url }) => {
    const ids = await seedWorkspace(admin);
    // A running run, then queued runs of both workflows, interleaved.
    const alreadyRunning = await insertRun(
      admin,
      ids,
      ids.unlimited,
      'running',
    );
    const limited: string[] = [];
    const unlimited: string[] = [];
    for (let index = 0; index < QUEUED_PER_WORKFLOW; index += 1) {
      limited.push(await insertQueuedRun(admin, ids, ids.limited));
      unlimited.push(await insertQueuedRun(admin, ids, ids.unlimited));
    }
    // The old dispatcher granted the limited head before the upgrade.
    await grantBeforeUpgrade(admin, url(maintenanceBaseUrl), ids, limited[0]);

    const stored = () => snapshot(admin);
    const before = await stored();
    await expect(upgrade()).resolves.toEqual([
      '0002_queue_head_admission.sql',
      '0003_ordered_start_wakeup.sql',
    ]);
    expect(await stored()).toEqual(before);

    const dispatcher = new Pool({
      connectionString: url(maintenanceBaseUrl),
      max: 1,
    });
    const worker = new Pool({ connectionString: url(appBaseUrl), max: 1 });
    try {
      const grants = [limited[0] ?? ''];
      const running = [alreadyRunning];
      const peaks = { workspace: 0, limited: 0 };
      await setStatus(worker, ids.workspaceId, limited[0] ?? '', 'running');
      running.push(limited[0] ?? '');
      for (let round = 0; round < 60; round += 1) {
        const granted = await claim(dispatcher, admin);
        grants.push(...granted);
        // Limited grants so far are exactly the head of its submission order.
        const limitedGrants = grants.filter((runId) => limited.includes(runId));
        expect(limitedGrants).toEqual(limited.slice(0, limitedGrants.length));
        const occupancy = await readOccupancy(admin, ids);
        peaks.workspace = Math.max(peaks.workspace, occupancy.workspace);
        peaks.limited = Math.max(peaks.limited, occupancy.limited);
        for (const runId of granted) {
          await setStatus(worker, ids.workspaceId, runId, 'running');
          running.push(runId);
        }
        // Unlimited runs finish first, so the limited workflow sits at its own
        // limit while workspace slots are free, and that limit is what binds.
        const unlimitedIndex = running.findIndex(
          (runId) => !limited.includes(runId),
        );
        const [done] = running.splice(Math.max(unlimitedIndex, 0), 1);
        if (done === undefined) break;
        await setStatus(worker, ids.workspaceId, done, 'succeeded');
      }

      expect(peaks.workspace).toBeLessThanOrEqual(WORKSPACE_LIMIT);
      expect(peaks.limited).toBeLessThanOrEqual(WORKFLOW_LIMIT);
      expect(peaks).toEqual({
        workspace: WORKSPACE_LIMIT,
        limited: WORKFLOW_LIMIT,
      });
      // Every queued run was admitted exactly once, and the backlog is gone.
      expect([...grants].sort()).toEqual([...limited, ...unlimited].sort());
      expect(
        (
          await admin.query<{ queued_runs: number; active_runs: number }>(
            'select queued_runs,active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
            [ids.workspaceId],
          )
        ).rows,
      ).toEqual([{ queued_runs: 0, active_runs: 0 }]);
    } finally {
      await dispatcher.end();
      await worker.end();
    }
  });
}, 180_000);

type Seeded = Awaited<ReturnType<typeof seedWorkspace>>;

/** A v0.2.0 database adopted by the baseline release, then migrated to 0001. */
async function withV020Plus0001(
  work: (context: {
    admin: Pool;
    upgrade: () => Promise<readonly string[]>;
    url: (baseUrl: string) => string;
  }) => Promise<void>,
) {
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_admission_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-admission-upgrade-'));
  const admin = new Pool({
    connectionString: fixture.databaseUrl(adminUrl),
    max: 2,
  });
  const config = {
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    connectionString: fixture.databaseUrl(migrationBaseUrl),
  };
  const add = (name: string) =>
    copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
  try {
    await fixture.create();
    // v0.2.0's schema is the baseline's; its receipts are the old history.
    await add('0000_baseline.sql');
    await migrateDatabase(config, directory);
    const history = JSON.parse(
      await readFile(
        join(MIGRATIONS_DIRECTORY, 'pre-baseline-history.json'),
        'utf8',
      ),
    ) as object[];
    await admin.query('delete from pertexo_internal.schema_migrations');
    await admin.query(
      'insert into pertexo_internal.schema_migrations(name,checksum) select name,checksum from jsonb_to_recordset($1::jsonb) as history(name text,checksum text)',
      [JSON.stringify(history)],
    );
    await expect(migrateDatabase(config, directory)).resolves.toEqual([]);
    await add('0001_ordinary_run_history.sql');
    await expect(migrateDatabase(config, directory)).resolves.toEqual([
      '0001_ordinary_run_history.sql',
    ]);
    await work({
      admin,
      upgrade: async () => {
        await add('0002_queue_head_admission.sql');
        await add('0003_ordered_start_wakeup.sql');
        return migrateDatabase(config, directory);
      },
      url: (baseUrl) => fixture.databaseUrl(baseUrl),
    });
  } finally {
    await admin.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedWorkspace(admin: Pool) {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const limited = { workflowId: randomUUID(), versionId: randomUUID() };
  const unlimited = { workflowId: randomUUID(), versionId: randomUUID() };
  await admin.query('select app.apply_instance_capacity($1,1000,1000)', [
    WORKSPACE_LIMIT,
  ]);
  await admin.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
    [ownerId, `${ownerId}@example.test`],
  );
  await admin.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1::uuid,'Upgrade workspace',$1::text,$2)",
    [workspaceId, ownerId],
  );
  await admin.query("select set_config('app.workspace_id',$1,false)", [
    workspaceId,
  ]);
  for (const [index, workflow] of [limited, unlimited].entries()) {
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Upgrade workflow',$3)",
      [workflow.workflowId, workspaceId, ownerId],
    );
    await admin.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
       values($1,$2,$3,1,'{}','{}',$4,$5)`,
      [
        workflow.versionId,
        workspaceId,
        workflow.workflowId,
        `wf:sha256:${String(index).repeat(64)}`,
        ownerId,
      ],
    );
  }
  await admin.query(
    'insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit) values($1,$2,$3)',
    [workspaceId, limited.workflowId, WORKFLOW_LIMIT],
  );
  return { workspaceId, limited, unlimited };
}

async function insertRun(
  admin: Pool,
  { workspaceId }: Seeded,
  workflow: Seeded['limited'],
  status: 'queued' | 'running',
): Promise<string> {
  const id = randomUUID();
  const client = await admin.connect();
  try {
    await client.query("select set_config('app.workspace_id',$1,false)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at)
       values($1,$2,$3,$4,'manual',$5,$6::jsonb,clock_timestamp()+interval '29 days')`,
      [
        id,
        workspaceId,
        workflow.workflowId,
        workflow.versionId,
        status,
        JSON.stringify({ kind: 'inline', value: { input: id } }),
      ],
    );
  } finally {
    client.release();
  }
  return id;
}

async function insertQueuedRun(
  admin: Pool,
  ids: Seeded,
  workflow: Seeded['limited'],
): Promise<string> {
  const runId = await insertRun(admin, ids, workflow, 'queued');
  const outboxEventId = randomUUID();
  const payload = { workspaceId: ids.workspaceId, runId, outboxEventId };
  await admin.query(
    `insert into app.outbox_events
       (id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
     values($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      ids.workspaceId,
      runId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  return runId;
}

/** What the v0.2.0 dispatcher does for one delivery: check, reserve, publish. */
async function grantBeforeUpgrade(
  admin: Pool,
  maintenanceUrl: string,
  { workspaceId }: Seeded,
  runId: string | undefined,
) {
  const event = await admin.query<{ id: string }>(
    'select id from app.outbox_events where aggregate_id=$1',
    [runId],
  );
  const eventId = event.rows[0]?.id;
  const pool = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('app.workflow_concurrency_protocol','1',true)",
      );
      const reserved = await client.query<{ reserved: boolean }>(
        'select app.reserve_workflow_run_active_admission($1,$2,$3) reserved',
        [workspaceId, eventId, runId],
      );
      expect(reserved.rows).toEqual([{ reserved: true }]);
      await client.query('commit');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  await markPublished(admin, eventId ?? '');
}

async function claim(dispatcher: Pool, admin: Pool): Promise<string[]> {
  const batch = await claimOutboxBatch(dispatcher, {
    enabledJobNames: ['advance-workflow-run'],
    leaseDurationMillis: 30_000,
    leaseOwner: 'admission-upgrade',
    leaseToken: randomUUID(),
    limit: 10,
  });
  for (const event of batch.events) await markPublished(admin, event.id);
  return batch.events.map((event) => event.aggregateId);
}

async function markPublished(admin: Pool, eventId: string) {
  await admin.query(
    'update app.outbox_events set published_at=clock_timestamp(),lease_expires_at=null,lease_owner=null,lease_token=null where id=$1',
    [eventId],
  );
}

async function setStatus(
  worker: Pool,
  workspaceId: string,
  runId: string,
  status: 'running' | 'succeeded',
) {
  const client = await worker.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query(
      "select set_config('app.workflow_concurrency_protocol','1',true)",
    );
    await client.query(
      'update app.workflow_runs set status=$3 where workspace_id=$1 and id=$2',
      [workspaceId, runId, status],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function readOccupancy(admin: Pool, ids: Seeded) {
  // A run holds a slot from its grant until it settles.
  const result = await admin.query<{ workspace: number; limited: number }>(
    `select count(*)::integer workspace,
            count(*) filter (where run.workflow_id=$2)::integer limited
       from app.workflow_runs run
      where run.workspace_id=$1
        and (run.status in ('running','waiting')
             or (run.status='queued' and exists (
                   select 1 from app.workflow_run_active_admissions admission
                    where admission.workflow_run_id=run.id)))`,
    [ids.workspaceId, ids.limited.workflowId],
  );
  return result.rows[0] ?? { workspace: 0, limited: 0 };
}

async function snapshot(admin: Pool) {
  const read = async (query: string): Promise<unknown[]> =>
    (await admin.query<Record<string, unknown>>(query)).rows;
  return {
    runs: await read('select * from app.workflow_runs order by id'),
    outbox: await read('select * from app.outbox_events order by id'),
    admissions: await read(
      'select * from app.workflow_run_active_admissions order by workflow_run_id',
    ),
    counters: await read(
      'select workspace_id,queued_runs,active_runs from app.workspace_execution_admission_counters order by workspace_id',
    ),
  };
}
