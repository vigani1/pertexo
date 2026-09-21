import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  createControlLedgerCoordinator,
  type AppendControlLedgerRecord,
  type ControlLedger,
  type ControlLedgerRecord,
} from '../src/lifecycle/control-ledger-coordinator.js';
import {
  createWorkspacePurgeCoordinator,
  type WorkspacePurgeLedger,
  type WorkspacePurgeLedgerRecord,
} from '../src/lifecycle/workspace-purge.js';
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
const operatorUrl = withDatabase(
  process.env.DATABASE_OPERATOR_URL ??
    'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo',
);
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
let maintenance: Pool | undefined;
let owner: Pool | undefined;
let operator: Pool | undefined;

class MemoryPurgeLedger implements WorkspacePurgeLedger {
  public appendCalls = 0;
  public failCommandType: WorkspacePurgeLedgerRecord['commandType'] | undefined;
  public failAfterFirstAppend = false;
  public malformedNextPageEnd = false;
  public repeatPreviousHashOnNextAppend = false;
  private readonly records = new Map<string, WorkspacePurgeLedgerRecord[]>();

  public async append(input: Parameters<WorkspacePurgeLedger['append']>[0]) {
    await Promise.resolve();
    this.appendCalls += 1;
    const workspaceRecords = this.records.get(input.workspaceId) ?? [];
    const existing = workspaceRecords.find(
      (record) => record.commandId === input.commandId,
    );
    if (existing !== undefined) return existing;
    const { signal, ...material } = input;
    signal?.throwIfAborted();
    const recordHash = this.repeatPreviousHashOnNextAppend
      ? input.previousHash
      : (input.sequence === 2 ? 'a' : 'b').repeat(64);
    this.repeatPreviousHashOnNextAppend = false;
    const record = {
      ...material,
      recordHash,
      schemaVersion: 1,
    };
    this.records.set(input.workspaceId, [...workspaceRecords, record]);
    if (this.failCommandType === input.commandType) {
      this.failCommandType = undefined;
      throw new Error(`ambiguous ${input.commandType} append result`);
    }
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
    const unprojected = (this.records.get(input.workspaceId) ?? [])
      .filter((record) => record.sequence > input.projectedSequence)
      .toSorted((left, right) => left.sequence - right.sequence);
    const records = unprojected.slice(0, input.maxRecords);
    if (
      records.length === 1 &&
      input.repairCommandId !== undefined &&
      input.repairCommandId !== records[0]?.commandId
    )
      throw new Error('repair command mismatch');
    const pageEndHash = records.at(-1)?.recordHash ?? input.projectedHash;
    const malformedPageEnd = this.malformedNextPageEnd;
    this.malformedNextPageEnd = false;
    return {
      hasMore: unprojected.length > records.length,
      pageEndHash: malformedPageEnd ? 'f'.repeat(64) : pageEndHash,
      pageEndSequence: records.at(-1)?.sequence ?? input.projectedSequence,
      reachedHighWater: true,
      records,
    };
  }
}

class MemoryObjectPurgeStore {
  public calls = 0;
  public failAfterDelete = false;
  public pauseNext = false;
  public readonly purgeStarted = Promise.withResolvers<undefined>();
  public readonly resumePurge = Promise.withResolvers<undefined>();

  public async purgeWorkspacePage() {
    await Promise.resolve();
    this.calls += 1;
    if (this.pauseNext) {
      this.pauseNext = false;
      this.purgeStarted.resolve(undefined);
      await this.resumePurge.promise;
    }
    if (this.failAfterDelete) {
      this.failAfterDelete = false;
      throw new Error('ambiguous object deletion result');
    }
    return { completed: true, deletedCount: 0 };
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

async function advanceToPurgeStartCandidate(
  coordinator: ReturnType<typeof createWorkspacePurgeCoordinator>,
  targetWorkspaceId: string,
): Promise<void> {
  if (maintenance === undefined)
    throw new Error('Maintenance pool unavailable');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [step, completion, start] = await Promise.all([
      maintenance.query('select * from app.find_due_workspace_purge_step()'),
      maintenance.query(
        'select * from app.find_due_workspace_purge_completion()',
      ),
      maintenance.query<{ workspace_id: string }>(
        'select * from app.find_due_workspace_purge()',
      ),
    ]);
    if (
      step.rows[0] === undefined &&
      completion.rows[0] === undefined &&
      start.rows[0]?.workspace_id === targetWorkspaceId
    )
      return;
    await coordinator.processNext();
  }
  throw new Error(
    `Purge start candidate was not reached: ${targetWorkspaceId}`,
  );
}

async function waitForApplicationLock(applicationName: string): Promise<void> {
  const observer = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await expect
      .poll(async () => {
        const activity = await observer.query<{ blocked: boolean }>(
          `select exists(
             select 1 from pg_stat_activity
              where application_name=$1 and wait_event_type='Lock'
           ) blocked`,
          [applicationName],
        );
        return activity.rows[0]?.blocked;
      })
      .toBe(true);
  } finally {
    await observer.end();
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_api,pertexo_worker,pertexo_dispatcher,
       pertexo_lifecycle_command,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(migrationConfig);
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
  owner = new Pool({ connectionString: databaseUrl, max: 1 });
  operator = new Pool({ connectionString: operatorUrl, max: 1 });
});

afterAll(async () => {
  await maintenance?.end();
  await owner?.end();
  await operator?.end();
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
    const objectStore = new MemoryObjectPurgeStore();
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
      objectStore,
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
      objectStore,
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
      expect(objectStore.calls).toBe(0);
      let completed = false;
      for (let page = 0; page < 20 && !completed; page += 1) {
        const outcome = await first.processNext();
        expect(['completed', 'progressed']).toContain(outcome.status);
        completed = outcome.status === 'completed';
      }
      expect(completed).toBe(true);
      expect(objectStore.calls).toBe(1);
      expect(ledger.appendCalls).toBe(2);
      if (owner === undefined) throw new Error('Owner pool unavailable');
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        const tombstone = await owner.query(
          `select workspace.name,workspace.slug,workspace.status,
             workspace.created_by,workspace.deletion_requested_by,
             workspace.deletion_reason,job.status job_status,
             completion.status completion_status
           from app.workspaces workspace
           join app.workspace_purge_jobs job on job.workspace_id=workspace.id
           join app.workspace_purge_completions completion on completion.job_id=job.id
           where workspace.id=$1`,
          [workspaceId],
        );
        expect(tombstone.rows[0]).toEqual({
          completion_status: 'projected',
          created_by: null,
          deletion_reason: 'purged',
          deletion_requested_by: null,
          job_status: 'completed',
          name: 'Deleted workspace',
          slug: `deleted-${workspaceId}`,
          status: 'deleted',
        });
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback');
        throw error;
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('reclaims one expired object-step lease and fences stale release and checkpoint attempts', async () => {
    if (maintenance === undefined || owner === undefined)
      throw new Error('Database pools unavailable');
    const workspaceId = await createDueWorkspace();
    const ledger = new MemoryPurgeLedger();
    const objectStore = new MemoryObjectPurgeStore();
    const options = {
      externalOperationTimeoutMs: 1_000,
      leaseOwner: 'purge-stale-step-a',
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
      objectStore,
      options,
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
      objectStore,
      { ...options, leaseOwner: 'purge-stale-step-b' },
    );
    try {
      await expect(first.processNext()).resolves.toMatchObject({
        status: 'started',
        workspaceId,
      });
      await owner.query('begin');
      let state:
        | {
            control_hash: string;
            control_sequence: string;
            job_id: string;
          }
        | undefined;
      try {
        await owner.query('set local role pertexo_owner');
        const current = await owner.query<{
          control_hash: string;
          control_sequence: string;
          job_id: string;
        }>(
          `select workspace.retention_control_hash control_hash,
                  workspace.retention_control_sequence::text control_sequence,
                  job.id job_id
             from app.workspaces workspace
             join app.workspace_purge_jobs job on job.workspace_id=workspace.id
            where workspace.id=$1`,
          [workspaceId],
        );
        state = current.rows[0];
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback');
        throw error;
      }
      if (state === undefined) throw new Error('Purge state missing');
      const staleClaim = await maintenance.query<{
        lease_fence: string;
        lease_token: string;
        step_name: string;
      }>(
        `select * from app.claim_workspace_purge_step(
          $1,$2,$3,'crashed-purge-worker',interval '1 minute'
        )`,
        [state.job_id, state.control_sequence, state.control_hash],
      );
      const staleLease = staleClaim.rows[0];
      expect(staleLease?.step_name).toBe('object_versions');
      if (staleLease === undefined) throw new Error('Step claim missing');

      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query(
          "select set_config('app.workspace_purge_transition','on',true)",
        );
        await owner.query(
          `update app.workspace_purge_steps
              set lease_acquired_at=clock_timestamp()-interval '2 seconds',
                  lease_expires_at=clock_timestamp()-interval '1 second'
            where job_id=$1 and step_name='object_versions'`,
          [state.job_id],
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback');
        throw error;
      }

      await expect(
        maintenance.query(
          'select app.release_workspace_purge_step($1,$2,$3) released',
          [state.job_id, staleLease.lease_token, staleLease.lease_fence],
        ),
      ).resolves.toMatchObject({ rows: [{ released: false }] });
      await expect(
        maintenance.query(
          `select app.checkpoint_workspace_object_versions_page(
            $1,$2,$3,0,true,$4,$5
          )`,
          [
            state.job_id,
            staleLease.lease_token,
            staleLease.lease_fence,
            state.control_sequence,
            state.control_hash,
          ],
        ),
      ).rejects.toMatchObject({ code: '55000' });

      const outcomes = await Promise.all([
        first.processNext(),
        second.processNext(),
      ]);
      expect(
        outcomes.every(({ status }) => ['idle', 'progressed'].includes(status)),
      ).toBe(true);
      expect(outcomes.some(({ status }) => status === 'progressed')).toBe(true);
      expect(objectStore.calls).toBe(1);

      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        const proof = await owner.query<{
          attempt_count: number;
          lease_fence: string;
          status: string;
        }>(
          `select attempt_count,lease_fence::text,status
             from app.workspace_purge_steps
            where job_id=$1 and step_name='object_versions'`,
          [state.job_id],
        );
        expect(proof.rows).toEqual([
          { attempt_count: 2, lease_fence: '2', status: 'completed' },
        ]);
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback');
        throw error;
      }
      let completed = false;
      for (let page = 0; page < 20 && !completed; page += 1) {
        const outcome = await first.processNext();
        completed =
          outcome.status === 'completed' && outcome.workspaceId === workspaceId;
      }
      expect(completed).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('retries object erasure after deletion succeeds before checkpointing', async () => {
    const workspaceId = await createDueWorkspace();
    const ledger = new MemoryPurgeLedger();
    const objectStore = new MemoryObjectPurgeStore();
    objectStore.failAfterDelete = true;
    const coordinator = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      objectStore,
      {
        externalOperationTimeoutMs: 1_000,
        leaseOwner: 'purge-object-retry',
        leaseSeconds: 5,
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
      },
    );
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        status: 'started',
        workspaceId,
      });
      await expect(coordinator.processNext()).rejects.toThrow(
        'ambiguous object deletion result',
      );
      await expect(coordinator.processNext()).resolves.toMatchObject({
        status: 'progressed',
        workspaceId,
      });
      expect(objectStore.calls).toBe(2);
      let completionDue = false;
      for (let page = 0; page < 20 && !completionDue; page += 1) {
        const due = await maintenance?.query<{
          workspace_id: string;
        }>('select * from app.find_due_workspace_purge_completion()');
        completionDue = due?.rows[0]?.workspace_id === workspaceId;
        if (!completionDue) {
          await expect(coordinator.processNext()).resolves.toMatchObject({
            status: 'progressed',
            workspaceId,
          });
        }
      }
      expect(completionDue).toBe(true);
      ledger.failCommandType = 'deletion_completed';
      await expect(coordinator.processNext()).resolves.toMatchObject({
        status: 'released',
        workspaceId,
      });
      await expect(coordinator.processNext()).resolves.toMatchObject({
        status: 'completed',
        workspaceId,
      });
      expect(ledger.appendCalls).toBe(2);
    } finally {
      await coordinator.close();
    }
  });

  it('persists one fenced command, starts purge, and leaves a held step retryable', async () => {
    if (
      maintenance === undefined ||
      owner === undefined ||
      operator === undefined
    )
      throw new Error('Database pools unavailable');
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
    const externalHoldId = randomUUID();
    const externalInvitationId = randomUUID();
    const externalIntentId = randomUUID();
    const externalClaimPriorIntentId = randomUUID();
    const incomingClaimPriorIntentId = randomUUID();
    const requestHash = '1'.repeat(64);
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
        `select app.project_workspace_legal_hold(
          $1,1,$2,'legal_hold_placed',$3,$4,$5,'operator:test',
          'purge-test','claim scan hold',clock_timestamp())`,
        [
          externalWorkspaceId,
          randomUUID(),
          externalHoldId,
          '0'.repeat(64),
          '7'.repeat(64),
        ],
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
          checksum,published_by,published_at
        ) values
          ($1,$3,$4,1,1,'{}',$5,$6,clock_timestamp()),
          ($2,$3,$4,2,1,'{}',$7,$6,clock_timestamp())`,
        [
          historicalVersionId,
          publishedVersionId,
          workspaceId,
          workflowId,
          `wf:v1:sha256:${'7'.repeat(64)}`,
          userId,
          `wf:v1:sha256:${'8'.repeat(64)}`,
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
        'update app.connections set current_secret_version_id=$2 where id=$1',
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
          compatibility_release_epoch,compatibility_release_fingerprint,
          actor_user_id,idempotency_key_hash,request_hash,executable_node_json,
          input_ref,side_effect_class,may_contact_provider,
          may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at
        )
        select $1,$2,$3,1,$4,'node-1','core.set',1,'core.set',1,
          current.epoch,current.fingerprint,$5,$6,$7,
          '{"id":"node-1","type":"core.set"}'::jsonb,
          '{"kind":"inline","schemaVersion":1,"value":null}'::jsonb,
          'safe',false,false,'not_supported',
          clock_timestamp()+interval '1 hour',
          clock_timestamp()+interval '2 days'
        from app.node_compatibility_current current`,
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
    const rerunCommandId = randomUUID();
    await expect(
      operator.query(
        "select * from app.request_operator_maintenance_rerun($1,$2,'workspace_purge_job',$3,'operator:purge-test','Prove maintenance rerun tenant cleanup',false)",
        [rerunCommandId, workspaceId, retry.rows[0]?.job_id],
      ),
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          command_outcome: 'rerun_requested',
          command_status: 'pending',
        }),
      ],
    });
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
    const objectClaim = await maintenance.query<{
      lease_fence: string;
      lease_token: string;
      step_name: string;
    }>(
      `select * from app.claim_workspace_purge_step(
        $1,4,$2,'integration-worker',interval '1 minute'
      )`,
      [retry.rows[0]?.job_id, releaseHash],
    );
    expect(objectClaim.rows[0]?.step_name).toBe('object_versions');
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query('select count(*) count from app.artifacts where id=$1', [
          artifactId,
        ]),
      ).resolves.toMatchObject({ rows: [{ count: '1' }] });
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
    await maintenance.query(
      `select app.checkpoint_workspace_object_versions_page(
        $1,$2,$3,0,true,4,$4
      )`,
      [
        retry.rows[0]?.job_id,
        objectClaim.rows[0]?.lease_token,
        objectClaim.rows[0]?.lease_fence,
        releaseHash,
      ],
    );
    await expect(
      maintenance.query(
        `select app.checkpoint_workspace_object_versions_page(
          $1,$2,$3,0,true,4,$4
        )`,
        [
          retry.rows[0]?.job_id,
          objectClaim.rows[0]?.lease_token,
          objectClaim.rows[0]?.lease_fence,
          releaseHash,
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await maintenance.query("select set_config('app.workspace_id',$1,false)", [
      workspaceId,
    ]);
    let tenantRowsCompleted = false;
    const claimScanPositions = new Set<string>();
    for (let page = 0; page < 80 && !tenantRowsCompleted; page += 1) {
      const claim = await maintenance.query<{
        lease_fence: string;
        lease_token: string;
        step_name: string;
      }>(
        `select * from app.claim_workspace_purge_step(
          $1,4,$2,'integration-worker',interval '1 minute'
        )`,
        [retry.rows[0]?.job_id, releaseHash],
      );
      const lease = claim.rows[0];
      if (lease === undefined)
        throw new Error('Expected tenant-row purge claim');
      expect(lease.step_name).toBe('tenant_rows');
      const executed = await maintenance.query<{
        completed: boolean;
        surface: string;
      }>(
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
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        const cursor = await owner.query<{
          cursor_position: string | null;
        }>(
          `select concat_ws(':',cursor_updated_at::text,
                    cursor_prior_workspace_id::text,cursor_prior_intent_id::text,
                    cursor_prior_binding_digest) cursor_position
             from app.workspace_invitation_claim_cleanup_cursors
            where scan_kind='workspace_purge' and scan_id=$1`,
          [retry.rows[0]?.job_id],
        );
        const position = cursor.rows[0]?.cursor_position;
        if (position !== undefined && position !== null)
          claimScanPositions.add(position);
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
    }
    expect(tenantRowsCompleted).toBe(true);
    expect(claimScanPositions.size).toBeGreaterThanOrEqual(2);
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          'select count(*)::int count from app.operator_maintenance_rerun_requests where command_id=$1',
          [rerunCommandId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
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
        completed_steps: string;
        status: string;
      }>(
        `select workspace.status,count(*) filter (where step.status='completed') completed_steps
         from app.workspaces workspace
         join app.workspace_purge_jobs job on job.workspace_id=workspace.id
         join app.workspace_purge_steps step on step.job_id=job.id
         where workspace.id=$1 group by workspace.status`,
        [workspaceId],
      );
      expect(state.rows[0]).toEqual({
        completed_steps: '2',
        status: 'purging',
      });
      const residue = await owner.query<{
        audit_sensitive: string;
        artifact_count: string;
        membership_count: string;
        replacement_claim_count: string;
        security_sensitive: string;
        usage_sensitive: string;
      }>(
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
      expect(residue.rows[0]).toEqual({
        audit_sensitive: '0',
        artifact_count: '0',
        membership_count: '0',
        replacement_claim_count: '12',
        security_sensitive: '0',
        usage_sensitive: '0',
      });
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `select app.project_workspace_legal_hold(
          $1,2,$2,'legal_hold_released',$3,$4,$5,'operator:test',
          'purge-test','claim scan released',clock_timestamp())`,
        [
          externalWorkspaceId,
          randomUUID(),
          externalHoldId,
          '7'.repeat(64),
          '8'.repeat(64),
        ],
      );
      await owner.query(
        `update app.workspace_invitation_acceptance_intents
            set status='superseded',updated_at=clock_timestamp()
          where id=$1`,
        [externalIntentId],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
    await expect(
      maintenance.query(
        'select * from app.reap_workspace_invitation_transients(10)',
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ replacement_claims_deleted: 10 })],
    });
    await expect(
      maintenance.query(
        'select * from app.reap_workspace_invitation_transients(10)',
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ replacement_claims_deleted: 2 })],
    });
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          `select count(*)::integer count
             from app.workspace_invitation_binding_replacement_claims
            where prior_workspace_id=$1 or successor_workspace_id=$1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
  });

  it('does not hold a transaction while object erasure is delayed', async () => {
    const workspaceId = await createDueWorkspace();
    const ledger = new MemoryPurgeLedger();
    const objectStore = new MemoryObjectPurgeStore();
    const coordinator = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      objectStore,
      {
        externalOperationTimeoutMs: 5_000,
        leaseOwner: 'purge-no-open-transaction',
        leaseSeconds: 30,
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
      },
    );
    try {
      let started = false;
      for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
        const outcome = await coordinator.processNext();
        started =
          outcome.status === 'started' && outcome.workspaceId === workspaceId;
      }
      expect(started).toBe(true);
      objectStore.pauseNext = true;
      const purging = coordinator.processNext();
      await objectStore.purgeStarted.promise;
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        const activity = await admin.query<{ count: string }>(
          `select count(*)::text count from pg_stat_activity
           where datname=$1 and usename='pertexo_maintenance'
             and xact_start is not null`,
          [databaseName],
        );
        expect(activity.rows[0]?.count).toBe('0');
      } finally {
        await admin.end();
        objectStore.resumePurge.resolve(undefined);
      }
      await expect(purging).resolves.toMatchObject({
        status: 'progressed',
        workspaceId,
      });
    } finally {
      objectStore.resumePurge.resolve(undefined);
      await coordinator.close();
    }
  });

  it('cancels a discovery query blocked inside PostgreSQL before follow-on purge work', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
    const blocker = await owner.connect();
    const observer = new Pool({ connectionString: adminUrl, max: 1 });
    const objectStore = new MemoryObjectPurgeStore();
    const ledger = new MemoryPurgeLedger();
    const coordinator = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      objectStore,
      {
        externalOperationTimeoutMs: 5_000,
        leaseOwner: 'purge-discovery-cancellation',
        leaseSeconds: 30,
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
      },
    );
    const controller = new AbortController();
    const reason = new Error('cancel blocked purge discovery');
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'lock table app.workspace_purge_steps in access exclusive mode',
      );
      const processing = coordinator.processNext(controller.signal);
      const rejection = expect(processing).rejects.toBe(reason);
      await expect
        .poll(async () => {
          const activity = await observer.query<{ waiting: boolean }>(
            `select exists(
               select 1 from pg_stat_activity
               where datname=$1 and usename='pertexo_maintenance'
                 and query like '%find_due_workspace_purge_step%'
                 and wait_event_type='Lock'
             ) waiting`,
            [databaseName],
          );
          return activity.rows[0]?.waiting;
        })
        .toBe(true);

      controller.abort(reason);
      await rejection;
      expect(objectStore.calls).toBe(0);
      expect(ledger.appendCalls).toBe(0);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await observer.end();
      await coordinator.close();
    }
  });

  it('serializes an authoritative hold append after purge-step freshness', async () => {
    const workspaceId = await createDueWorkspace();
    const holdId = randomUUID();
    const commandId = randomUUID();
    const records: ControlLedgerRecord[] = [];
    const freshnessStarted = Promise.withResolvers<undefined>();
    const releaseFreshness = Promise.withResolvers<undefined>();
    let pauseFreshness = false;
    let pausedFreshness = false;
    const reconcile = async (input: {
      maxRecords: number;
      projectedHash: string;
      projectedSequence: number;
      repairCommandId?: string;
      signal?: AbortSignal;
      workspaceId: string;
    }) => {
      if (pauseFreshness && !pausedFreshness) {
        pausedFreshness = true;
        freshnessStarted.resolve(undefined);
        await releaseFreshness.promise;
      }
      const available = records
        .filter(
          (record) =>
            record.workspaceId === input.workspaceId &&
            record.sequence > input.projectedSequence,
        )
        .slice(0, input.maxRecords);
      const last = available.at(-1);
      const hasMore = records.some(
        (record) =>
          record.workspaceId === input.workspaceId &&
          record.sequence > (last?.sequence ?? input.projectedSequence),
      );
      return {
        hasMore,
        pageEndHash: last?.recordHash ?? input.projectedHash,
        pageEndSequence: last?.sequence ?? input.projectedSequence,
        reachedHighWater: !hasMore,
        records: available,
      };
    };
    const appendRecord = (input: {
      actorRef: string;
      commandId: string;
      commandType: ControlLedgerRecord['commandType'];
      legalAuthority?: string;
      occurredAt: string;
      previousHash: string;
      reason: string;
      sequence: number;
      signal?: AbortSignal;
      subjectId: string;
      workspaceId: string;
    }): ControlLedgerRecord => {
      input.signal?.throwIfAborted();
      const { signal: _signal, ...material } = input;
      void _signal;
      const record = Object.freeze({
        ...material,
        recordHash: input.sequence.toString(16).padStart(64, '0'),
        schemaVersion: 1,
      });
      records.push(record);
      return record;
    };
    const controlAppend = vi.fn((input: AppendControlLedgerRecord) =>
      Promise.resolve(appendRecord(input)),
    );
    const controlLedger: ControlLedger = {
      append: controlAppend,
      reconcile,
    };
    const purgeLedger: WorkspacePurgeLedger = {
      append: (input) => Promise.resolve(appendRecord(input)),
      reconcile: async (input) => {
        const page = await reconcile(input);
        return {
          ...page,
          records: page.records,
        };
      },
    };
    const objectStore = new MemoryObjectPurgeStore();
    const purgeCoordinator = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      purgeLedger,
      objectStore,
      {
        externalOperationTimeoutMs: 5_000,
        leaseOwner: 'purge-hold-race',
        leaseSeconds: 30,
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
      },
    );
    const commandApplicationName = `purge-command-${randomUUID()}`;
    const commandUrl = new URL(maintenanceUrl);
    commandUrl.searchParams.set('application_name', commandApplicationName);
    const commandCoordinator = createControlLedgerCoordinator(
      {
        connectionString: commandUrl.toString(),
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      controlLedger,
      { externalOperationTimeoutMs: 5_000 },
    );
    let purgeResult: Promise<unknown> | undefined;
    let holdResult: Promise<unknown> | undefined;
    try {
      await advanceToPurgeStartCandidate(purgeCoordinator, workspaceId);
      await expect(purgeCoordinator.processNext()).resolves.toMatchObject({
        status: 'started',
        workspaceId,
      });
      const objectCallsBeforeRace = objectStore.calls;
      pauseFreshness = true;
      purgeResult = purgeCoordinator.processNext();
      await freshnessStarted.promise;
      holdResult = commandCoordinator.placeLegalHold({
        actorRef: 'legal-admin',
        commandId,
        holdId,
        legalAuthority: 'case-workspace-purge-race',
        occurredAt: '2026-09-08T00:00:00.000Z',
        reason: 'serialize workspace purge race',
        workspaceId,
      });
      await waitForApplicationLock(commandApplicationName);
      expect(controlAppend).not.toHaveBeenCalled();
      expect(objectStore.calls).toBe(objectCallsBeforeRace);

      releaseFreshness.resolve(undefined);
      await expect(purgeResult).resolves.toMatchObject({
        status: 'progressed',
        workspaceId,
      });
      await expect(holdResult).resolves.toMatchObject({
        commandId,
        holdId,
        replayed: false,
        workspaceId,
      });
      expect(objectStore.calls).toBe(objectCallsBeforeRace + 1);
      expect(controlAppend).toHaveBeenCalledOnce();
      await commandCoordinator.releaseLegalHold({
        actorRef: 'legal-admin',
        commandId: randomUUID(),
        holdId,
        legalAuthority: 'case-workspace-purge-race',
        occurredAt: '2026-09-08T00:00:01.000Z',
        reason: 'release workspace purge race hold',
        workspaceId,
      });
      let completed = false;
      for (let attempt = 0; attempt < 20 && !completed; attempt += 1) {
        const outcome = await purgeCoordinator.processNext();
        completed =
          outcome.status === 'completed' && outcome.workspaceId === workspaceId;
      }
      expect(completed).toBe(true);
    } finally {
      releaseFreshness.resolve(undefined);
      await Promise.allSettled([
        purgeResult ?? Promise.resolve(),
        holdResult ?? Promise.resolve(),
      ]);
      await Promise.all([purgeCoordinator.close(), commandCoordinator.close()]);
    }
  });

  it('rejects a malformed ledger page boundary before preparing purge work', async () => {
    const workspaceId = await createDueWorkspace();
    const ledger = new MemoryPurgeLedger();
    const objectStore = new MemoryObjectPurgeStore();
    const coordinator = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      objectStore,
      {
        externalOperationTimeoutMs: 1_000,
        leaseOwner: 'purge-malformed-page',
        leaseSeconds: 5,
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
      },
    );
    try {
      await advanceToPurgeStartCandidate(coordinator, workspaceId);
      const appendCallsBeforeMalformedPage = ledger.appendCalls;
      const objectCallsBeforeMalformedPage = objectStore.calls;
      ledger.malformedNextPageEnd = true;
      await expect(coordinator.processNext()).rejects.toThrow(
        'Workspace purge requires exact control ledger high water',
      );
      expect(ledger.appendCalls).toBe(appendCallsBeforeMalformedPage);
      expect(objectStore.calls).toBe(objectCallsBeforeMalformedPage);

      let completed = false;
      for (let attempt = 0; attempt < 20 && !completed; attempt += 1) {
        const outcome = await coordinator.processNext();
        completed =
          outcome.status === 'completed' && outcome.workspaceId === workspaceId;
      }
      expect(completed).toBe(true);
    } finally {
      await coordinator.close();
    }
  });

  it('rejects a ledger record whose hash repeats its previous hash', async () => {
    const workspaceId = await createDueWorkspace();
    const ledger = new MemoryPurgeLedger();
    const objectStore = new MemoryObjectPurgeStore();
    const coordinator = createWorkspacePurgeCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      ledger,
      objectStore,
      {
        externalOperationTimeoutMs: 1_000,
        leaseOwner: 'purge-repeated-hash',
        leaseSeconds: 5,
        lockTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
      },
    );
    try {
      await advanceToPurgeStartCandidate(coordinator, workspaceId);
      const appendCallsBeforeRepeatedHash = ledger.appendCalls;
      const objectCallsBeforeRepeatedHash = objectStore.calls;
      ledger.repeatPreviousHashOnNextAppend = true;
      await expect(coordinator.processNext()).resolves.toMatchObject({
        status: 'released',
        workspaceId,
      });
      expect(ledger.appendCalls).toBe(appendCallsBeforeRepeatedHash + 1);
      expect(objectStore.calls).toBe(objectCallsBeforeRepeatedHash);
    } finally {
      await coordinator.close();
    }
  });
});
