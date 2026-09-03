import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTROL_LEDGER_ZERO_HASH,
  createControlLedgerCoordinator,
} from '../src/control-ledger-coordinator.js';
import {
  MemoryLedger,
  createControlLedgerCoordinatorTestEnvironment,
} from './support/control-ledger-coordinator.integration.support.js';

const environment = createControlLedgerCoordinatorTestEnvironment();
const {
  apiUrl,
  backlogWorkspaceId,
  cancellationWorkspaceId,
  committedArtifactIds,
  failureWorkspaceId,
  invalidWorkspaceId,
  maintenanceUrl,
  migrationConfig,
  progressWorkspaceId,
  timeoutWorkspaceId,
  workspaceId,
} = environment;
let maintenance: Pool | undefined;
beforeAll(async () => {
  ({ maintenance } = await environment.initialize());
}, 120_000);
afterAll(environment.close);

describe('control ledger coordinator exact 0045 to 0047 integration', () => {
  it('proves the maintenance boundary and stable complete inventory', async () => {
    const coordinator = createControlLedgerCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: migrationConfig.ownerRole,
        workerRuntimeRole: migrationConfig.workerRuntimeRole,
      },
      new MemoryLedger(),
      { inventoryPageSize: 3 },
    );
    try {
      await expect(
        coordinator.checkRestoreReadiness({
          expectedMaintenanceRole: migrationConfig.maintenanceRole,
        }),
      ).resolves.toBeUndefined();
      await expect(coordinator.reconcileAllWorkspaces()).resolves.toMatchObject(
        {
          projectedRecordCount: 0,
          sweepCount: 2,
          workspaceCount: 8,
        },
      );
      const firstArtifacts = await coordinator.listCommittedArtifacts({
        limit: 1,
      });
      const firstCommittedArtifactId = committedArtifactIds[0];
      if (firstCommittedArtifactId === undefined)
        throw new Error('Committed artifact fixture is empty');
      expect(firstArtifacts).toEqual({
        artifacts: [
          {
            artifactId: firstCommittedArtifactId,
            byteLength: 5,
            mediaType: 'text/plain',
            sha256:
              '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
            workspaceId,
          },
        ],
        hasMore: true,
      });
      await expect(
        coordinator.listCommittedArtifacts({
          afterArtifactId: firstCommittedArtifactId,
          afterWorkspaceId: workspaceId,
          limit: 1,
        }),
      ).resolves.toEqual({
        artifacts: [
          expect.objectContaining({ artifactId: committedArtifactIds[1] }),
        ],
        hasMore: false,
      });
    } finally {
      await coordinator.close();
    }
  });

  it('keeps maintenance least privileged and serializes the workspace lock', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    await expect(
      maintenance.query('select * from app.workspaces'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          "select app.validate_workspace_legal_hold_command($1,'legal_hold_placed',$2)",
          [workspaceId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
    await expect(
      maintenance.query(
        'select * from app.lock_workspace_control_ledger(null)',
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        "select app.validate_workspace_legal_hold_command(null,'legal_hold_placed',$1)",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        "select app.validate_workspace_legal_hold_command($1,'LEGAL_HOLD_PLACED',$2)",
        [workspaceId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query('select * from app.lock_workspace_control_ledger($1)', [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '23503' });

    const first = await maintenance.connect();
    const second = await maintenance.connect();
    try {
      await first.query('begin');
      await first.query('select * from app.lock_workspace_control_ledger($1)', [
        workspaceId,
      ]);
      await second.query('begin');
      let acquired = false;
      const waiting = second
        .query('select * from app.lock_workspace_control_ledger($1)', [
          workspaceId,
        ])
        .then(() => {
          acquired = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      await first.query('commit');
      await waiting;
      expect(acquired).toBe(true);
      await second.query('commit');
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('leaves PostgreSQL unchanged when append fails', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    ledger.failAppend = true;
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
    await expect(
      coordinator.placeLegalHold({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        holdId: randomUUID(),
        legalAuthority: 'case-append-failure',
        occurredAt: '2026-08-26T12:00:00.000Z',
        reason: 'append failure proof',
        workspaceId: failureWorkspaceId,
      }),
    ).rejects.toThrow('ledger unavailable');
    const highWater = await maintenance.query(
      'select * from app.lock_workspace_control_ledger($1)',
      [failureWorkspaceId],
    );
    expect(highWater.rows[0]).toMatchObject({
      retention_control_hash: CONTROL_LEDGER_ZERO_HASH,
      retention_control_sequence: '0',
    });
    await coordinator.close();
  });

  it('rejects invalid transitions before creating external records', async () => {
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
    const base = {
      actorRef: 'operator:test',
      commandId: randomUUID(),
      holdId: randomUUID(),
      legalAuthority: 'case-invalid-transitions',
      occurredAt: '2026-08-26T12:00:00.000Z',
      reason: 'transition preflight proof',
      workspaceId: invalidWorkspaceId,
    };
    await expect(coordinator.releaseLegalHold(base)).rejects.toMatchObject({
      code: '55000',
    });
    expect(ledger.records.get(invalidWorkspaceId) ?? []).toHaveLength(0);

    await coordinator.placeLegalHold({ ...base, commandId: randomUUID() });
    await expect(
      coordinator.placeLegalHold({ ...base, commandId: randomUUID() }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(ledger.records.get(invalidWorkspaceId) ?? []).toHaveLength(1);

    await coordinator.releaseLegalHold({ ...base, commandId: randomUUID() });
    await expect(
      coordinator.releaseLegalHold({ ...base, commandId: randomUUID() }),
    ).rejects.toMatchObject({ code: '55000' });
    expect(ledger.records.get(invalidWorkspaceId) ?? []).toHaveLength(2);
    await coordinator.close();
  });

  it('keeps the row lock until external timeout rollback', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    ledger.hangReconcile = true;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    ledger.reconcileStarted = notifyStarted;
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { externalOperationTimeoutMs: 1_000 },
    );
    const reconciling = coordinator.reconcileWorkspace({
      workspaceId: timeoutWorkspaceId,
    });
    await started;
    const waiter = await maintenance.connect();
    try {
      await waiter.query('begin');
      let acquired = false;
      const waiting = waiter
        .query('select * from app.lock_workspace_control_ledger($1)', [
          timeoutWorkspaceId,
        ])
        .then(() => {
          acquired = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      await expect(reconciling).rejects.toMatchObject({ name: 'TimeoutError' });
      await waiting;
      expect(acquired).toBe(true);
      await waiter.query('commit');
    } finally {
      await waiter.query('rollback').catch(() => undefined);
      waiter.release();
      await coordinator.close();
    }
  });

  it('cancels an in-flight workspace lock query with the caller reason', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const blocker = await maintenance.connect();
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
    try {
      await blocker.query('begin');
      await blocker.query(
        'select * from app.lock_workspace_control_ledger($1)',
        [cancellationWorkspaceId],
      );
      const controller = new AbortController();
      const reason = new Error('operator cancelled lock wait');
      const pending = coordinator.reconcileWorkspace({
        signal: controller.signal,
        workspaceId: cancellationWorkspaceId,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await coordinator.close();
    }
  });

  it('durably commits bounded chunks and appends after backlog catch-up', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    const seed = async (targetWorkspaceId: string, count: number) => {
      let previousHash = CONTROL_LEDGER_ZERO_HASH;
      for (let sequence = 1; sequence <= count; sequence += 1) {
        const appended = await ledger.append({
          actorRef: 'operator:seed',
          commandId: randomUUID(),
          commandType: 'legal_hold_placed',
          legalAuthority: 'case-backlog',
          occurredAt: `2026-08-26T12:0${String(sequence)}:00.000Z`,
          previousHash,
          reason: 'backlog reconciliation proof',
          sequence,
          subjectId: randomUUID(),
          workspaceId: targetWorkspaceId,
        });
        previousHash = appended.recordHash;
      }
    };
    await seed(progressWorkspaceId, 2);
    const bounded = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { maxPages: 1, maxRecords: 1, pageSize: 1 },
    );
    await expect(
      bounded.reconcileWorkspace({ workspaceId: progressWorkspaceId }),
    ).rejects.toThrow('invocation bound exceeded');
    const progressed = await maintenance.query<{
      retention_control_sequence: string;
    }>('select * from app.lock_workspace_control_ledger($1)', [
      progressWorkspaceId,
    ]);
    expect(progressed.rows[0]?.retention_control_sequence).toBe('1');
    await expect(
      bounded.reconcileWorkspace({ workspaceId: progressWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 2, projectedCount: 1 });
    await bounded.close();

    await seed(backlogWorkspaceId, 2);
    const command = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { maxPages: 2, maxRecords: 2, pageSize: 1 },
    );
    await expect(
      command.placeLegalHold({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        holdId: randomUUID(),
        legalAuthority: 'case-command-backlog',
        occurredAt: '2026-08-26T12:03:00.000Z',
        reason: 'append only after catch-up',
        workspaceId: backlogWorkspaceId,
      }),
    ).resolves.toMatchObject({ sequence: 3 });
    expect(ledger.records.get(backlogWorkspaceId) ?? []).toHaveLength(3);
    await command.close();
  });
});
