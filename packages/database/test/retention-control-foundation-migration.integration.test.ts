import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const roleBaseUrls = {
  api:
    process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
  dispatcher:
    process.env.DATABASE_DISPATCHER_URL ??
    'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo',
  maintenance:
    process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
  worker:
    process.env.DATABASE_WORKER_URL ??
    'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo',
} as const;
const databaseName = `pertexo_test_retention_control_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const databaseUrl = withDatabase(migrationBaseUrl);
const migrationConfig = {
  connectionString: databaseUrl,
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
} as const;
const workspaceId = randomUUID();
const userId = randomUUID();
const runId = randomUUID();
const holdOne = randomUUID();
const holdTwo = randomUUID();
const zeroHash = '0'.repeat(64);
const hashes = [
  '1'.repeat(64),
  '2'.repeat(64),
  '3'.repeat(64),
  '4'.repeat(64),
] as const;
const occurredAt = new Date('2026-08-26T12:00:00.000Z');
let priorDirectory = '';
let owner: Pool | undefined;
let roles: Record<keyof typeof roleBaseUrls, Pool> | undefined;
let beforeTenantSnapshot: unknown;

async function asOwner<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = owner;
  if (pool === undefined) throw new Error('Owner pool unavailable');
  await pool.query('begin');
  try {
    await pool.query('set local role pertexo_owner');
    const result = await operation(pool);
    await pool.query('commit');
    return result;
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function tenantSnapshot(): Promise<unknown> {
  return asOwner(async (pool) => {
    await pool.query(
      'alter table app.workflow_runs no force row level security',
    );
    const result = await pool.query<{ snapshot: unknown }>(
      `select jsonb_build_object(
         'user',(select to_jsonb(value) from app.users value where id=$1),
         'workspace',(select to_jsonb(value)-'updated_at'-'retention_control_sequence'-'retention_control_hash'
                        from app.workspaces value where id=$2),
         'run',(select to_jsonb(value) from app.workflow_runs value where id=$3),
         'counts',jsonb_build_object(
           'users',(select count(*) from app.users),
           'workspaces',(select count(*) from app.workspaces),
           'workflowRuns',(select count(*) from app.workflow_runs),
           'artifacts',(select count(*) from app.artifacts),
           'connections',(select count(*) from app.connections)
         )
       ) snapshot`,
      [userId, workspaceId, runId],
    );
    await pool.query('alter table app.workflow_runs force row level security');
    return result.rows[0]?.snapshot;
  });
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,
       pertexo_worker,pertexo_dispatcher,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }

  priorDirectory = await mkdtemp(
    path.join(tmpdir(), 'retention-control-prior-'),
  );
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_.+\.sql$/u.test(name) && name < '0044_')
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
  }
  await expect(
    migrateDatabase(migrationConfig, priorDirectory),
  ).resolves.toHaveLength(44);
  const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrationPool.query('begin');
    await migrationPool.query('set local role pertexo_owner');
    const priorHead = await migrationPool.query<{ name: string }>(
      'select name from pertexo_internal.schema_migrations order by name desc limit 1',
    );
    expect(priorHead.rows[0]?.name).toBe(
      '0043_workflow_run_input_retention.sql',
    );
    await migrationPool.query('commit');
  } finally {
    await migrationPool.end();
  }

  owner = new Pool({ connectionString: databaseUrl, max: 1 });
  await asOwner(async (pool) => {
    await pool.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await pool.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Retention control fixture')`,
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Retention control fixture',$2,$3)`,
      [workspaceId, `retention-control-${workspaceId}`, userId],
    );
    await pool.query(
      'alter table app.workflow_runs no force row level security',
    );
    await pool.query(
      `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,
        input_ref_expires_at,output_ref,error_summary,created_at,updated_at)
       values($1,$2,$3,$4,'manual','queued',$5::jsonb,'2026-07-31T00:00:00Z',
         $6::jsonb,'retained-error-summary','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
      [
        runId,
        workspaceId,
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'inline',
          value: 'must-survive',
        }),
        JSON.stringify({ schemaVersion: 1, kind: 'inline', value: 'output' }),
      ],
    );
    await pool.query('alter table app.workflow_runs force row level security');
  });
  beforeTenantSnapshot = await tenantSnapshot();

  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0044_retention_control_foundation.sql'),
    path.join(priorDirectory, '0044_retention_control_foundation.sql'),
  );
  await expect(
    migrateDatabase(migrationConfig, priorDirectory),
  ).resolves.toEqual(['0044_retention_control_foundation.sql']);
  roles = Object.fromEntries(
    Object.entries(roleBaseUrls).map(([name, url]) => [
      name,
      new Pool({
        connectionString: withDatabase(url),
        max: name === 'maintenance' ? 3 : 1,
      }),
    ]),
  ) as Record<keyof typeof roleBaseUrls, Pool>;
}, 120_000);

afterAll(async () => {
  if (roles !== undefined)
    await Promise.all(Object.values(roles).map((pool) => pool.end()));
  await owner?.end();
  if (priorDirectory !== '')
    await rm(priorDirectory, { recursive: true, force: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('retention control foundation exact prior-head upgrade', () => {
  it('rejects forged workspace high water and denies every role direct control-table DML', async () => {
    if (roles === undefined) throw new Error('Role pools unavailable');
    await expect(
      roles.api.query(
        `insert into app.workspaces
          (id,name,slug,created_by,retention_control_sequence,retention_control_hash)
         values($1,'Forged control state',$2,$3,9,$4)`,
        [randomUUID(), `forged-${randomUUID()}`, userId, 'f'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '22023' });

    const tables = [
      'workspace_control_ledger_projection',
      'workspace_legal_holds',
      'retention_control_audit_facts',
      'retention_batches',
    ];
    for (const pool of Object.values(roles)) {
      const privileges = await pool.query<{ allowed: boolean }>(
        `select has_table_privilege(current_user,'app.' || table_name,privilege) allowed
           from unnest($1::text[]) table_name
           cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege`,
        [tables],
      );
      expect(privileges.rows.every(({ allowed }) => !allowed)).toBe(true);
    }

    const callable = await roles.maintenance.query<{
      name: string;
      security_definer: boolean;
    }>(
      `select proc.proname name,proc.prosecdef security_definer
         from pg_proc proc join pg_namespace namespace on namespace.oid=proc.pronamespace
        where namespace.nspname='app'
          and has_function_privilege(current_user,proc.oid,'EXECUTE')
        order by proc.proname`,
    );
    expect(callable.rows).toEqual(
      [
        'checkpoint_retention_batch',
        'claim_retention_batches',
        'project_workspace_legal_hold',
        'start_retention_batch',
      ].map((name) => ({ name, security_definer: true })),
    );
    const guard = await roles.maintenance.query<{ guard: string | null }>(
      "select to_regprocedure('app.retention_destruction_guard(uuid,bigint,character)')::text guard",
    );
    expect(guard.rows[0]?.guard).toBeNull();
  });

  it('serializes legal-hold projection and rejects replay, sequence, hash, and release conflicts', async () => {
    const maintenance = roles?.maintenance;
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const commands = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;
    const project = (
      pool: Pool | PoolClient,
      sequence: number,
      commandId: string,
      commandType: string,
      holdId: string,
      previousHash: string,
      recordHash: string,
    ) =>
      pool.query<{ projected: boolean }>(
        `select app.project_workspace_legal_hold(
          $1,$2,$3,$4,$5,$6,$7,' operator:test ',' launch-policy ',' case-reference ',$8
        ) projected`,
        [
          workspaceId,
          sequence,
          commandId,
          commandType,
          holdId,
          previousHash,
          recordHash,
          occurredAt,
        ],
      );

    const firstClient = await maintenance.connect();
    const secondClient = await maintenance.connect();
    try {
      await firstClient.query('begin');
      await project(
        firstClient,
        1,
        commands[0],
        'legal_hold_placed',
        holdOne,
        zeroHash,
        hashes[0],
      );
      let secondSettled = false;
      const secondProjection = project(
        secondClient,
        2,
        commands[1],
        'legal_hold_placed',
        holdTwo,
        hashes[0],
        hashes[1],
      ).finally(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondSettled).toBe(false);
      await firstClient.query('commit');
      await expect(secondProjection).resolves.toMatchObject({
        rows: [{ projected: true }],
      });
    } finally {
      await firstClient.query('rollback').catch(() => undefined);
      firstClient.release();
      secondClient.release();
    }

    await expect(
      project(
        maintenance,
        1,
        commands[0],
        'legal_hold_placed',
        holdOne,
        zeroHash,
        hashes[0],
      ),
    ).resolves.toMatchObject({ rows: [{ projected: false }] });
    await expect(
      project(
        maintenance,
        3,
        commands[0],
        'legal_hold_placed',
        holdTwo,
        hashes[1],
        hashes[2],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      maintenance.query(
        `select app.project_workspace_legal_hold(
          $1,3,$2,'legal_hold_placed',$3,$4,$5,null,'launch-policy','case-reference',$6
        )`,
        [
          workspaceId,
          randomUUID(),
          randomUUID(),
          hashes[1],
          hashes[2],
          occurredAt,
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      project(
        maintenance,
        4,
        randomUUID(),
        'legal_hold_placed',
        randomUUID(),
        hashes[1],
        hashes[2],
      ),
    ).rejects.toMatchObject({
      code: '40001',
      message: 'retention control sequence mismatch',
    });
    await expect(
      project(
        maintenance,
        3,
        randomUUID(),
        'legal_hold_placed',
        randomUUID(),
        zeroHash,
        hashes[2],
      ),
    ).rejects.toMatchObject({
      code: '40001',
      message: 'retention control previous hash mismatch',
    });

    await project(
      maintenance,
      3,
      commands[2],
      'legal_hold_released',
      holdOne,
      hashes[1],
      hashes[2],
    );
    const oneActive = await asOwner((pool) =>
      pool.query<{ count: string }>(
        'select count(*) from app.workspace_legal_holds where released_sequence is null',
      ),
    );
    expect(oneActive.rows[0]?.count).toBe('1');
    await expect(
      project(
        maintenance,
        4,
        randomUUID(),
        'legal_hold_released',
        holdOne,
        hashes[2],
        hashes[3],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await project(
      maintenance,
      4,
      commands[3],
      'legal_hold_released',
      holdTwo,
      hashes[2],
      hashes[3],
    );

    const projected = await asOwner((pool) =>
      pool.query<{
        actor_ref: string;
        legal_authority: string;
        reason: string;
        subject_id: string;
      }>(
        `select actor_ref,legal_authority,reason,subject_id
           from app.workspace_control_ledger_projection order by sequence`,
      ),
    );
    expect(projected.rows).toHaveLength(4);
    expect(projected.rows[0]).toMatchObject({
      actor_ref: 'operator:test',
      legal_authority: 'launch-policy',
      reason: 'case-reference',
      subject_id: holdOne,
    });
  });

  it('starts only canonical audited dry runs with exact replay and fenced monotonic progress', async () => {
    const maintenance = roles?.maintenance;
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const batchId = randomUUID();
    const cutoff = new Date('2026-08-25T00:00:00.000Z');
    const start = (
      id: string,
      dryRun: boolean,
      requestedBy: string,
      reason: string,
    ) =>
      maintenance.query(
        'select app.start_retention_batch($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          workspaceId,
          ' input-retention-2026-08-25 ',
          'workflow_run_input',
          cutoff,
          dryRun,
          requestedBy,
          reason,
        ],
      );
    await expect(
      start(batchId, false, 'operator:test', 'inspect due run inputs'),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        'select app.start_retention_batch($1,$2,$3,$4,$5,true,null,$6)',
        [
          randomUUID(),
          workspaceId,
          'null-requester',
          'workflow_run_input',
          cutoff,
          'inspect due run inputs',
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      start(batchId, true, ' operator:test ', ' inspect due run inputs '),
    ).resolves.toMatchObject({ rows: [{ start_retention_batch: batchId }] });
    await expect(
      start(batchId, true, 'operator:test', 'inspect due run inputs'),
    ).resolves.toMatchObject({ rows: [{ start_retention_batch: batchId }] });
    await expect(
      start(batchId, true, 'operator:test', 'different reason'),
    ).rejects.toMatchObject({ code: '23505' });

    const audit = await asOwner(async (pool) => {
      await pool.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      return pool.query<{ metadata: Record<string, unknown> }>(
        `select metadata from app.audit_events
          where action='retention.batch_started' and target_id=$1`,
        [batchId],
      );
    });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      dryRun: true,
      reason: 'inspect due run inputs',
      requestedBy: 'operator:test',
      retentionKind: 'workflow_run_input',
    });
    expect(new Date(String(audit.rows[0]?.metadata.cutoffAt))).toEqual(cutoff);

    const first = await maintenance.query<{
      dry_run: boolean;
      lease_fence: string;
      lease_token: string;
      reason: string;
      requested_by: string;
    }>('select * from app.claim_retention_batches($1,1,1)', [
      ' maintenance-one ',
    ]);
    expect(first.rows[0]).toMatchObject({
      dry_run: true,
      reason: 'inspect due run inputs',
      requested_by: 'operator:test',
    });
    // Claim eligibility is an owner-only PostgreSQL function over the real
    // fenced lease; exercise its database-clock boundary without bypassing it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await maintenance.query<{
      lease_fence: string;
      lease_token: string;
    }>('select * from app.claim_retention_batches($1,1,30)', [
      'maintenance-two',
    ]);
    expect(Number(second.rows[0]?.lease_fence)).toBe(
      Number(first.rows[0]?.lease_fence) + 1,
    );
    const cursorExpiresAt = new Date('2026-07-31T00:00:00.000Z');
    const cursorId = randomUUID();
    const stale = await maintenance.query<{ checkpointed: boolean }>(
      'select app.checkpoint_retention_batch($1,$2,$3,$4,$5,1,1,false) checkpointed',
      [
        batchId,
        first.rows[0]?.lease_token,
        first.rows[0]?.lease_fence,
        cursorExpiresAt,
        cursorId,
      ],
    );
    expect(stale.rows[0]?.checkpointed).toBe(false);
    await expect(
      maintenance.query(
        'select app.checkpoint_retention_batch($1,$2,$3,null,null,1,1,false)',
        [batchId, second.rows[0]?.lease_token, second.rows[0]?.lease_fence],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        'select app.checkpoint_retention_batch($1,$2,$3,$4,$5,1,1,false)',
        [
          batchId,
          second.rows[0]?.lease_token,
          second.rows[0]?.lease_fence,
          new Date(cutoff.getTime() + 1),
          randomUUID(),
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        'select app.checkpoint_retention_batch($1,$2,$3,$4,$5,1,1,false)',
        [
          batchId,
          second.rows[0]?.lease_token,
          second.rows[0]?.lease_fence,
          cursorExpiresAt,
          cursorId,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ checkpoint_retention_batch: true }] });
    await expect(
      maintenance.query(
        'select app.checkpoint_retention_batch($1,$2,$3,$4,$5,1,0,false)',
        [
          batchId,
          second.rows[0]?.lease_token,
          second.rows[0]?.lease_fence,
          cursorExpiresAt,
          cursorId,
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        'select app.checkpoint_retention_batch($1,$2,$3,null,null,0,0,true)',
        [batchId, second.rows[0]?.lease_token, second.rows[0]?.lease_fence],
      ),
    ).resolves.toMatchObject({ rows: [{ checkpoint_retention_batch: true }] });
  });

  it('enforces immutable linked facts and leaves all retained tenant data unchanged', async () => {
    await expect(
      asOwner((pool) =>
        pool.query(
          'update app.workspace_control_ledger_projection set reason=$1 where workspace_id=$2',
          ['rewritten', workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          'delete from app.retention_control_audit_facts where workspace_id=$1',
          [workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          'update app.workspace_legal_holds set placement_reason=$1 where workspace_id=$2',
          ['rewritten', workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          'delete from app.workspace_control_ledger_projection where workspace_id=$1',
          [workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query('delete from app.retention_batches where workspace_id=$1', [
          workspaceId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          'update app.retention_control_audit_facts set actor_ref=$1 where workspace_id=$2',
          ['rewritten', workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          'delete from app.workspace_legal_holds where workspace_id=$1',
          [workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          'update app.retention_batches set reason=$1 where workspace_id=$2',
          ['rewritten', workspaceId],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asOwner((pool) =>
        pool.query(
          `insert into app.retention_control_audit_facts
            (id,workspace_id,command_id,fact_type,subject_id,control_sequence,
             control_record_hash,actor_ref,occurred_at)
           values($1,$2,$3,'legal_hold_placed',$4,1,$5,'operator:test',$6)`,
          [
            randomUUID(),
            workspaceId,
            randomUUID(),
            randomUUID(),
            hashes[0],
            occurredAt,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      asOwner((pool) =>
        pool.query(
          `insert into app.workspace_legal_holds
            (workspace_id,hold_id,placed_sequence,placed_record_hash,legal_authority,
             placement_reason,placed_by,placed_at,released_sequence)
           values($1,$2,1,$3,'launch-policy','case-reference','operator:test',$4,2)`,
          [workspaceId, randomUUID(), hashes[0], occurredAt],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asOwner((pool) =>
        pool.query(
          `insert into app.workspace_legal_holds
            (workspace_id,hold_id,placed_sequence,placed_record_hash,legal_authority,
             placement_reason,placed_by,placed_at)
           values($1,$2,1,$3,'launch-policy','case-reference','operator:test',$4)`,
          [workspaceId, randomUUID(), hashes[0], occurredAt],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(tenantSnapshot()).resolves.toEqual(beforeTenantSnapshot);
  });
});
