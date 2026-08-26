import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  createWorkspacePurgeCoordinator,
  type WorkspacePurgeLedger,
  type WorkspacePurgeLedgerRecord,
} from '../src/workspace-purge.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
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
const databaseUrl = withDatabase(migrationBaseUrl);
const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
const migrationConfig = {
  connectionString: databaseUrl,
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
} as const;
let maintenance: Pool | undefined;
let owner: Pool | undefined;

class MemoryPurgeLedger implements WorkspacePurgeLedger {
  public appendCalls = 0;
  public failAfterFirstAppend = false;
  private readonly records = new Map<string, WorkspacePurgeLedgerRecord>();

  public async append(input: Parameters<WorkspacePurgeLedger['append']>[0]) {
    await Promise.resolve();
    this.appendCalls += 1;
    const existing = this.records.get(input.workspaceId);
    if (existing !== undefined) return existing;
    const { signal, ...material } = input;
    signal?.throwIfAborted();
    const record = {
      ...material,
      recordHash: 'a'.repeat(64),
      schemaVersion: 1,
    };
    this.records.set(input.workspaceId, record);
    if (this.failAfterFirstAppend) {
      this.failAfterFirstAppend = false;
      throw new Error('ambiguous append result');
    }
    return record;
  }

  public async reconcile(
    input: Parameters<WorkspacePurgeLedger['reconcile']>[0],
  ) {
    await Promise.resolve();
    const record = this.records.get(input.workspaceId);
    const records =
      record === undefined || record.sequence <= input.projectedSequence
        ? []
        : [record];
    if (
      records.length === 1 &&
      input.repairCommandId !== undefined &&
      input.repairCommandId !== record?.commandId
    )
      throw new Error('repair command mismatch');
    return {
      hasMore: false,
      pageEndHash: record?.recordHash ?? input.projectedHash,
      pageEndSequence: record?.sequence ?? input.projectedSequence,
      reachedHighWater: true,
      records,
    };
  }
}

async function createDueWorkspace(): Promise<string> {
  if (maintenance === undefined || owner === undefined)
    throw new Error('Database pools unavailable');
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const requestHash = '6'.repeat(64);
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Purge owner')",
      [userId, `${userId}@example.test`],
    );
    await owner.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge fixture',$2,$3)",
      [workspaceId, `purge-${workspaceId}`, userId],
    );
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback');
    throw error;
  }
  await maintenance.query(
    `select app.project_workspace_deletion(
      $1,1,$2,'deletion_requested',$1,$3,$4,$5,null,'Purge recovery fixture',
      clock_timestamp()-interval '31 days'
    )`,
    [workspaceId, randomUUID(), '0'.repeat(64), requestHash, userId],
  );
  return workspaceId;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_api,pertexo_worker,pertexo_dispatcher,
       pertexo_lifecycle_command`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(migrationConfig);
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
  owner = new Pool({ connectionString: databaseUrl, max: 1 });
});

afterAll(async () => {
  await maintenance?.end();
  await owner?.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('workspace purge foundation', () => {
  it('repairs an ambiguous purge append and treats a concurrent claim as idle', async () => {
    const workspaceId = await createDueWorkspace();
    const ledger = new MemoryPurgeLedger();
    ledger.failAfterFirstAppend = true;
    const coordinatorOptions = {
      externalOperationTimeoutMs: 1_000,
      leaseOwner: 'purge-integration-a',
      leaseSeconds: 5,
      lockTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
    } as const;
    const first = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      coordinatorOptions,
    );
    const second = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      { ...coordinatorOptions, leaseOwner: 'purge-integration-b' },
    );
    try {
      await expect(first.processNext()).resolves.toMatchObject({
        status: 'released',
        workspaceId,
      });
      const outcomes = await Promise.all([
        first.processNext(),
        second.processNext(),
      ]);
      expect(outcomes.map(({ status }) => status).sort()).toEqual([
        'idle',
        'started',
      ]);
      expect(ledger.appendCalls).toBe(1);
      let completed = false;
      for (let page = 0; page < 20 && !completed; page += 1) {
        const outcome = await first.processNext();
        expect(['completed', 'progressed']).toContain(outcome.status);
        completed = outcome.status === 'completed';
      }
      expect(completed).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('persists one fenced command, starts purge, and leaves a held step retryable', async () => {
    if (maintenance === undefined || owner === undefined)
      throw new Error('Database pools unavailable');
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const requestHash = '1'.repeat(64);
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
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
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
    await maintenance.query(
      `select app.project_workspace_deletion(
        $1,1,$2,'deletion_requested',$1,$3,$4,$5,null,$6,
        clock_timestamp()-interval '31 days'
      )`,
      [
        workspaceId,
        randomUUID(),
        '0'.repeat(64),
        requestHash,
        userId,
        'Workspace purge integration request',
      ],
    );

    const first = await maintenance.query<{
      command_id: string;
      job_id: string;
      lease_fence: string;
      lease_token: string;
    }>(
      `select * from app.prepare_workspace_purge_job(
        $1,1,$2,'integration-worker',interval '1 minute'
      )`,
      [workspaceId, requestHash],
    );
    const firstJob = first.rows[0];
    expect(firstJob).toBeDefined();
    await expect(
      maintenance.query(
        'select app.release_workspace_purge_job($1,$2,$3) released',
        [firstJob?.job_id, firstJob?.lease_token, firstJob?.lease_fence],
      ),
    ).resolves.toMatchObject({ rows: [{ released: true }] });
    const retry = await maintenance.query<{
      command_id: string;
      job_id: string;
      lease_fence: string;
      lease_token: string;
    }>(
      `select * from app.prepare_workspace_purge_job(
        $1,1,$2,'integration-worker',interval '1 minute'
      )`,
      [workspaceId, requestHash],
    );
    expect(retry.rows[0]?.command_id).toBe(firstJob?.command_id);
    expect(Number(retry.rows[0]?.lease_fence)).toBe(
      Number(firstJob?.lease_fence) + 1,
    );
    const purgeHash = '2'.repeat(64);
    await maintenance.query(
      'select app.project_workspace_purge_started($1,$2,$3,2,$4,$5)',
      [
        retry.rows[0]?.job_id,
        retry.rows[0]?.lease_token,
        retry.rows[0]?.lease_fence,
        requestHash,
        purgeHash,
      ],
    );

    const holdHash = '3'.repeat(64);
    const holdId = randomUUID();
    await maintenance.query(
      `select app.project_workspace_legal_hold(
        $1,3,$2,'legal_hold_placed',$3,$4,$5,'operator:legal',
        'case-123','Preserve tenant rows',clock_timestamp()
      )`,
      [workspaceId, randomUUID(), holdId, purgeHash, holdHash],
    );
    await expect(
      maintenance.query('select * from app.find_due_workspace_purge_step()'),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      maintenance.query(
        `select * from app.claim_workspace_purge_step(
          $1,3,$2,'integration-worker',interval '1 minute'
        )`,
        [retry.rows[0]?.job_id, holdHash],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    const releaseHash = '4'.repeat(64);
    await maintenance.query(
      `select app.project_workspace_legal_hold(
        $1,4,$2,'legal_hold_released',$3,$4,$5,'operator:legal',
        'case-123','Release tenant row preservation',clock_timestamp()
      )`,
      [workspaceId, randomUUID(), holdId, holdHash, releaseHash],
    );
    let tenantRowsCompleted = false;
    for (let page = 0; page < 20 && !tenantRowsCompleted; page += 1) {
      const claim = await maintenance.query<{
        lease_fence: string;
        lease_token: string;
      }>(
        `select * from app.claim_workspace_purge_step(
          $1,4,$2,'integration-worker',interval '1 minute'
        )`,
        [retry.rows[0]?.job_id, releaseHash],
      );
      const lease = claim.rows[0];
      if (lease === undefined)
        throw new Error('Expected tenant-row purge claim');
      const executed = await maintenance.query<{ completed: boolean }>(
        `select * from app.execute_workspace_tenant_rows_page(
          $1,$2,$3,10,4,$4
        )`,
        [
          retry.rows[0]?.job_id,
          lease.lease_token,
          lease.lease_fence,
          releaseHash,
        ],
      );
      tenantRowsCompleted = executed.rows[0]?.completed === true;
    }
    expect(tenantRowsCompleted).toBe(true);
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,5,$2,'deletion_completed',$1,$3,$4,'maintenance:workspace-purge',
          null,'Must remain incomplete',clock_timestamp()
        )`,
        [workspaceId, randomUUID(), releaseHash, '5'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      const state = await owner.query<{
        status: string;
        step_status: string;
      }>(
        `select workspace.status,step.status step_status
         from app.workspaces workspace
         join app.workspace_purge_jobs job on job.workspace_id=workspace.id
         join app.workspace_purge_steps step on step.job_id=job.id
         where workspace.id=$1`,
        [workspaceId],
      );
      expect(state.rows[0]).toEqual({
        status: 'purging',
        step_status: 'completed',
      });
      const residue = await owner.query<{
        audit_sensitive: string;
        membership_count: string;
        security_sensitive: string;
        usage_sensitive: string;
      }>(
        `select
          (select count(*) from app.workspace_memberships where workspace_id=$1) membership_count,
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
      expect(residue.rows[0]).toEqual({
        audit_sensitive: '0',
        membership_count: '0',
        security_sensitive: '0',
        usage_sensitive: '0',
      });
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
  });
});
