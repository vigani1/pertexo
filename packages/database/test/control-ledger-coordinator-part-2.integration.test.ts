import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTROL_LEDGER_ZERO_HASH,
  createControlLedgerCoordinator,
  type ControlLedgerRecord,
} from '../src/control-ledger-coordinator.js';
import {
  MemoryLedger,
  createControlLedgerCoordinatorTestEnvironment,
} from './support/control-ledger-coordinator.integration.support.js';

const environment = createControlLedgerCoordinatorTestEnvironment();
const {
  apiUrl,
  deletionWorkspaceId,
  maintenanceUrl,
  migrationConfig,
  migrationUrl,
  workspaceId,
} = environment;
let deletionActorId = '';
let maintenance: Pool | undefined;
beforeAll(async () => {
  ({ deletionActorId, maintenance } = await environment.initialize());
}, 120_000);
afterAll(environment.close);

describe('control ledger coordinator exact 0045 to 0047 integration', () => {
  it('recovers the append crash window and projects place/release/multiple holds exactly', async () => {
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { pageSize: 1 },
    );
    const firstCommand = randomUUID();
    const firstHold = randomUUID();
    const controller = new AbortController();
    ledger.abortAfterAppend = controller;
    const firstInput = {
      actorRef: 'operator:test',
      commandId: firstCommand,
      holdId: firstHold,
      legalAuthority: 'case-one',
      occurredAt: '2026-08-26T12:01:00.000Z',
      reason: 'first hold',
      workspaceId,
    };
    await expect(
      coordinator.placeLegalHold({ ...firstInput, signal: controller.signal }),
    ).rejects.toThrow('simulated process interruption');
    await expect(coordinator.placeLegalHold(firstInput)).resolves.toMatchObject(
      {
        replayed: true,
        sequence: 1,
      },
    );
    const secondHold = randomUUID();
    await expect(
      coordinator.placeLegalHold({
        ...firstInput,
        commandId: randomUUID(),
        holdId: secondHold,
        occurredAt: '2026-08-26T12:02:00.000Z',
        reason: 'second hold',
      }),
    ).resolves.toMatchObject({ sequence: 2 });
    const releaseCommand = randomUUID();
    await expect(
      coordinator.releaseLegalHold({
        ...firstInput,
        commandId: releaseCommand,
        legalAuthority: 'case-one-release',
        occurredAt: '2026-08-26T12:03:00.000Z',
        reason: 'release first hold',
      }),
    ).resolves.toMatchObject({ sequence: 3 });

    const verifier = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await verifier.query('begin');
      await verifier.query('set local role pertexo_owner');
      const rows = await verifier.query(
        `select retention_control_sequence,retention_control_hash,
          (select count(*) from app.workspace_legal_holds where workspace_id=$1) hold_count,
          (select count(*) from app.workspace_legal_holds where workspace_id=$1 and released_sequence is null) active_count
         from app.workspaces where id=$1`,
        [workspaceId],
      );
      expect(rows.rows[0]).toMatchObject({
        active_count: '1',
        hold_count: '2',
        retention_control_hash: '3'.padStart(64, '0'),
        retention_control_sequence: '3',
      });
      await verifier.query('commit');
    } finally {
      await verifier.end();
    }
    await coordinator.close();
  });

  it('projects request, restore, purge start, and completion from event time without deletion SQL', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
    );
    const seeded: ControlLedgerRecord[] = [];
    ledger.records.set(deletionWorkspaceId, seeded);
    const seedDeletion = (
      commandType:
        | 'deletion_requested'
        | 'deletion_restored'
        | 'purge_started'
        | 'deletion_completed',
      occurredAt: string,
      reason: string,
    ): ControlLedgerRecord => {
      const previous = seeded.at(-1);
      const sequence = (previous?.sequence ?? 0) + 1;
      const record: ControlLedgerRecord = {
        actorRef: deletionActorId,
        commandId: randomUUID(),
        commandType,
        occurredAt,
        previousHash: previous?.recordHash ?? CONTROL_LEDGER_ZERO_HASH,
        reason,
        recordHash: sequence.toString(16).padStart(64, '0'),
        schemaVersion: 1,
        sequence,
        subjectId: deletionWorkspaceId,
        workspaceId: deletionWorkspaceId,
      };
      seeded.push(record);
      return record;
    };
    const requested = seedDeletion(
      'deletion_requested',
      '2026-01-01T00:00:00.000Z',
      'Deletion lifecycle integration proof',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 1, projectedCount: 1 });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,2,$2,'deletion_restored',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          requested.recordHash,
          'e'.repeat(64),
          deletionActorId,
          'Restore cannot predate request',
          '2025-12-31T23:59:59.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    seedDeletion(
      'deletion_restored',
      '2026-01-02T00:00:00.000Z',
      'Restore before deadline',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 2, projectedCount: 1 });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,3,$2,'deletion_requested',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          '2'.padStart(64, '0'),
          'e'.repeat(64),
          deletionActorId,
          'New request cannot predate restore',
          '2026-01-01T12:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    seedDeletion(
      'deletion_requested',
      '2026-01-03T00:00:00.000Z',
      'Second deletion lifecycle request',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 3, projectedCount: 1 });
    seedDeletion(
      'purge_started',
      '2026-02-02T00:00:00.000Z',
      'Authoritative purge workflow started',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 4, projectedCount: 1 });
    const holdId = randomUUID();
    await coordinator.placeLegalHold({
      actorRef: 'operator:retention',
      commandId: randomUUID(),
      holdId,
      legalAuthority: 'case-deletion-completion-block',
      occurredAt: '2026-02-02T01:00:00.000Z',
      reason: 'Hold before deletion completion',
      workspaceId: deletionWorkspaceId,
    });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,6,$2,'deletion_completed',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          '5'.padStart(64, '0'),
          'f'.repeat(64),
          deletionActorId,
          'Completion must fail under hold',
          '2026-02-03T00:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await coordinator.releaseLegalHold({
      actorRef: 'operator:retention',
      commandId: randomUUID(),
      holdId,
      legalAuthority: 'case-deletion-completion-release',
      occurredAt: '2026-02-02T02:00:00.000Z',
      reason: 'Release hold for deletion completion',
      workspaceId: deletionWorkspaceId,
    });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,7,$2,'deletion_completed',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          '6'.padStart(64, '0'),
          'e'.repeat(64),
          deletionActorId,
          'Completion cannot predate purge start',
          '2026-02-01T00:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    seedDeletion(
      'deletion_completed',
      '2026-02-03T00:00:00.000Z',
      'Authoritative purge workflow completed',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).rejects.toMatchObject({ code: '55000' });

    const verifier = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await verifier.query('begin');
      await verifier.query('set local role pertexo_owner');
      const state = await verifier.query<{
        deletion_requested_at: Date | string;
        fact_count: string;
        purge_after: Date | string;
        retention_control_sequence: string;
        status: string;
      }>(
        `select status,deletion_requested_at,purge_after,retention_control_sequence,
          (select count(*) from app.retention_control_audit_facts where workspace_id=$1) fact_count
         from app.workspaces where id=$1`,
        [deletionWorkspaceId],
      );
      expect(state.rows[0]).toMatchObject({
        fact_count: '6',
        retention_control_sequence: '6',
        status: 'purging',
      });
      const row = state.rows[0];
      if (row === undefined)
        throw new Error('Missing deletion workspace state');
      expect(new Date(row.deletion_requested_at).toISOString()).toBe(
        '2026-01-03T00:00:00.000Z',
      );
      expect(new Date(row.purge_after).toISOString()).toBe(
        '2026-02-02T00:00:00.000Z',
      );
      await verifier.query('commit');
    } finally {
      await verifier.query('rollback').catch(() => undefined);
      await verifier.end();
      await coordinator.close();
    }
  });

  it('keeps anchor enumeration maintenance-only and denies legacy API lifecycle writes', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    await expect(
      maintenance.query(
        'select * from app.enumerate_workspace_control_anchors(null,101)',
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        'select * from app.enumerate_workspace_control_anchors(null,2)',
      ),
    ).resolves.toMatchObject({ rowCount: 2 });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          'select * from app.enumerate_workspace_control_anchors(null,1)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query("update app.workspaces set status='suspended' where id=$1", [
          workspaceId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          `update app.workspaces set status='pending_deletion',
             deletion_requested_at='2026-08-26T00:00:00Z',
             deletion_requested_by=$2,deletion_reason='legacy API proof',
             purge_after='2026-09-25T00:00:00Z'
           where id=$1`,
          [workspaceId, deletionActorId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          `update app.workspaces set status='suspended',deletion_requested_at=null,
             deletion_requested_by=null,deletion_reason=null,purge_after=null
           where id=$1`,
          [workspaceId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          `update app.workspaces set retention_control_sequence=retention_control_sequence+1
           where id=$1`,
          [workspaceId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
  });
});
