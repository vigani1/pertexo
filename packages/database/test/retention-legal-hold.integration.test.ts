import { describe, expect, it, vi } from 'vitest';

import {
  createControlLedgerCoordinator,
  type AppendControlLedgerRecord,
  type ControlLedgerRecord,
} from '../src/lifecycle/control-ledger-coordinator.js';

import {
  type ControlLedger,
  Pool,
  createRetentionEnforcementCoordinator,
  cutoffAt,
  maintenanceUrl,
  owner,
  parseDatabaseConfig,
  randomUUID,
  retention,
  userId,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
  zeroHash,
} from './support/retention.integration.support.js';

describe('retention legal hold fencing', () => {
  it('releases unprovable ledger work and durably pauses an active legal hold', async () => {
    const protectedRunId = randomUUID();
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      await owner.query(
        `insert into app.workflow_runs
          (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           input_ref,input_ref_expires_at,created_at,updated_at)
         values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,
           $6::timestamptz-interval '30 days',$6::timestamptz-interval '30 days')`,
        [
          protectedRunId,
          workspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'held' }),
          '2026-07-15T00:00:00.000Z',
        ],
      );
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    const unavailableBatchId = randomUUID();
    await retention.startEnforcement({
      batchId: unavailableBatchId,
      cutoffAt,
      idempotencyKey: `retention-${unavailableBatchId}`,
      reason: 'prove ledger freshness failure',
      requestedBy: 'integration-operator',
      workspaceId,
    });
    const aheadLedger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: 'a'.repeat(64),
          pageEndSequence: 1,
          reachedHighWater: true,
          records: [
            {
              actorRef: 'legal-admin',
              commandId: randomUUID(),
              commandType: 'legal_hold_placed' as const,
              legalAuthority: 'case-1',
              occurredAt: '2026-08-20T00:00:00.000Z',
              previousHash: zeroHash,
              reason: 'preserve evidence',
              recordHash: 'a'.repeat(64),
              schemaVersion: 1,
              sequence: 1,
              subjectId: randomUUID(),
              workspaceId,
            },
          ],
        }),
      ),
    } satisfies ControlLedger;
    const unavailableCoordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      aheadLedger,
      { leaseOwner: 'retention-ledger-ahead', leaseSeconds: 60 },
    );
    try {
      await expect(unavailableCoordinator.processNext()).resolves.toMatchObject(
        {
          batchId: unavailableBatchId,
          examinedCount: 0,
          status: 'released',
        },
      );
    } finally {
      await unavailableCoordinator.close();
    }
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      const retained = await owner.query<{ input_ref: unknown }>(
        'select input_ref from app.workflow_runs where id=$1',
        [protectedRunId],
      );
      expect(retained.rows).toEqual([
        {
          input_ref: { kind: 'inline', schemaVersion: 1, value: 'held' },
        },
      ]);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const holdId = randomUUID();
    const holdHash = 'b'.repeat(64);
    const maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
    try {
      await maintenance.query(
        `select app.project_workspace_legal_hold(
          $1,1,$2,'legal_hold_placed',$3,$4,$5,
          'legal-admin','case-2','preserve evidence',$6)`,
        [
          workspaceId,
          randomUUID(),
          holdId,
          zeroHash,
          holdHash,
          '2026-08-21T00:00:00.000Z',
        ],
      );
    } finally {
      await maintenance.end();
    }
    const heldClaimIntentId = randomUUID();
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest)
         values($1,$2,$3,$1,$4,$5,1,$6,$7)`,
        [
          workspaceId,
          heldClaimIntentId,
          '1'.repeat(64),
          randomUUID(),
          randomUUID(),
          '2'.repeat(64),
          '3'.repeat(64),
        ],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    await expect(retention.reapTransientData()).resolves.toMatchObject({
      invitationReplacementClaimsDeleted: 0,
    });
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          `select count(*)::integer count
             from app.workspace_invitation_binding_replacement_claims
            where prior_workspace_id=$1 and prior_intent_id=$2`,
          [workspaceId, heldClaimIntentId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    const heldLedger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: holdHash,
          pageEndSequence: 1,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    const heldCoordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      heldLedger,
      { leaseOwner: 'retention-held', leaseSeconds: 60 },
    );
    try {
      await expect(heldCoordinator.processNext()).resolves.toMatchObject({
        batchId: unavailableBatchId,
        examinedCount: 0,
        status: 'paused',
      });
    } finally {
      await heldCoordinator.close();
    }
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      const proof = await owner.query(
        `select batch.status,batch.pause_reason,run.input_ref
         from app.retention_batches batch cross join app.workflow_runs run
         where batch.id=$1 and run.id=$2`,
        [unavailableBatchId, protectedRunId],
      );
      expect(proof.rows).toEqual([
        {
          input_ref: { kind: 'inline', schemaVersion: 1, value: 'held' },
          pause_reason: 'legal_hold',
          status: 'paused',
        },
      ]);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  it('serializes an authoritative hold append after input-retention freshness', async () => {
    const raceWorkspaceId = randomUUID();
    const protectedRunId = randomUUID();
    const batchId = randomUUID();
    const commandId = randomUUID();
    const holdId = randomUUID();
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        raceWorkspaceId,
      ]);
      await owner.query(
        `insert into app.workspaces(id,name,slug,created_by)
         values($1,'Retention hold race',$2,$3)`,
        [raceWorkspaceId, `retention-hold-race-${raceWorkspaceId}`, userId],
      );
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      await owner.query(
        `insert into app.workflow_runs(
           id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           input_ref,input_ref_expires_at,created_at,updated_at
         ) values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,
           $6::timestamptz-interval '30 days',$6::timestamptz-interval '30 days')`,
        [
          protectedRunId,
          raceWorkspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'race' }),
          '2026-07-15T00:00:00.000Z',
        ],
      );
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    await retention.startEnforcement({
      batchId,
      cutoffAt,
      idempotencyKey: `retention-hold-race-${batchId}`,
      reason: 'serialize input deletion and authoritative hold append',
      requestedBy: 'integration-operator',
      workspaceId: raceWorkspaceId,
    });

    const freshnessStarted = Promise.withResolvers<undefined>();
    const releaseFreshness = Promise.withResolvers<undefined>();
    const records: ControlLedgerRecord[] = [];
    let pausedFreshness = false;
    const appendRecord = vi.fn((input: AppendControlLedgerRecord) => {
      const record = Object.freeze({
        ...input,
        recordHash: (input.commandType === 'legal_hold_placed'
          ? 'c'
          : 'd'
        ).repeat(64),
        schemaVersion: 1,
      });
      records.push(record);
      return Promise.resolve(record);
    });
    const ledger: ControlLedger = {
      append: appendRecord,
      reconcile: vi.fn(
        async (input: Parameters<ControlLedger['reconcile']>[0]) => {
          if (input.repairCommandId === undefined && !pausedFreshness) {
            pausedFreshness = true;
            freshnessStarted.resolve(undefined);
            await releaseFreshness.promise;
          }
          const available = records
            .filter((record) => record.sequence > input.projectedSequence)
            .slice(0, input.maxRecords);
          const last = available.at(-1);
          const hasMore = records.some(
            (record) =>
              record.sequence > (last?.sequence ?? input.projectedSequence),
          );
          return {
            hasMore,
            pageEndHash: last?.recordHash ?? input.projectedHash,
            pageEndSequence: last?.sequence ?? input.projectedSequence,
            reachedHighWater: !hasMore,
            records: available,
          };
        },
      ),
    };
    const commandApplicationName = `retention-input-command-${randomUUID()}`;
    const retentionCoordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      ledger,
      { leaseOwner: 'retention-input-race', leaseSeconds: 60 },
    );
    const commandCoordinator = createControlLedgerCoordinator(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          maintenanceUrl,
          commandApplicationName,
        ),
        max: 2,
      }),
      ledger,
      { externalOperationTimeoutMs: 5_000 },
    );
    let retentionResult: Promise<unknown> | undefined;
    let holdResult: Promise<unknown> | undefined;
    try {
      retentionResult = retentionCoordinator.processNext();
      await freshnessStarted.promise;
      holdResult = commandCoordinator.placeLegalHold({
        actorRef: 'legal-admin',
        commandId,
        holdId,
        legalAuthority: 'case-input-retention-race',
        occurredAt: '2026-09-08T00:00:00.000Z',
        reason: 'serialize input retention race',
        workspaceId: raceWorkspaceId,
      });
      await waitForPostgresLock(commandApplicationName);
      expect(appendRecord).not.toHaveBeenCalled();

      releaseFreshness.resolve(undefined);
      await expect(retentionResult).resolves.toMatchObject({
        batchId,
        eligibleCount: 1,
        status: 'completed',
        workspaceId: raceWorkspaceId,
      });
      await expect(holdResult).resolves.toMatchObject({
        commandId,
        holdId,
        replayed: false,
        workspaceId: raceWorkspaceId,
      });
      expect(appendRecord).toHaveBeenCalledOnce();
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          raceWorkspaceId,
        ]);
        await owner.query(
          'alter table app.workflow_runs no force row level security',
        );
        const run = await owner.query<{ input_ref: unknown }>(
          'select input_ref from app.workflow_runs where id=$1',
          [protectedRunId],
        );
        expect(run.rows).toEqual([{ input_ref: null }]);
        await owner.query(
          'alter table app.workflow_runs force row level security',
        );
        await owner.query('rollback');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
      await commandCoordinator.releaseLegalHold({
        actorRef: 'legal-admin',
        commandId: randomUUID(),
        holdId,
        legalAuthority: 'case-input-retention-race',
        occurredAt: '2026-09-08T00:00:01.000Z',
        reason: 'release input retention race hold',
        workspaceId: raceWorkspaceId,
      });
    } finally {
      releaseFreshness.resolve(undefined);
      await Promise.allSettled([
        retentionResult ?? Promise.resolve(),
        holdResult ?? Promise.resolve(),
      ]);
      await Promise.all([
        retentionCoordinator.close(),
        commandCoordinator.close(),
      ]);
    }
  });
});
