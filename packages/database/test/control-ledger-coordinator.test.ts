import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  CONTROL_LEDGER_ZERO_HASH,
  ControlLedgerCommandConflictError,
  ControlLedgerReconciliationError,
  createControlLedgerCoordinator,
  type AppendControlLedgerRecord,
  type ControlLedger,
  type ControlLedgerRecord,
} from '../src/lifecycle/control-ledger-coordinator.js';

const workspaceId = randomUUID();
const holdId = randomUUID();
const commandId = randomUUID();
const occurredAt = '2026-08-26T12:00:00.000Z';
const config = {
  connectionString: 'postgresql://maintenance:secret@localhost/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
    actorRef: 'operator:test',
    commandId,
    holdId,
    legalAuthority: 'case-123',
    occurredAt,
    reason: 'Preserve records',
    workspaceId,
    ...overrides,
  };
}

class MemoryLedger implements ControlLedger {
  public readonly calls: string[] = [];
  public readonly records: ControlLedgerRecord[] = [];
  public events: string[] | undefined;
  public failAppend = false;
  public hangAppend = false;
  public hangReconcile = false;
  public pageSizeOverride: number | undefined;

  public async append(
    request: AppendControlLedgerRecord,
  ): Promise<ControlLedgerRecord> {
    await Promise.resolve();
    this.calls.push('append');
    this.events?.push('append');
    request.signal?.throwIfAborted();
    if (this.failAppend) throw new Error('append failed');
    const existing = this.records.find(
      (record) =>
        record.workspaceId === request.workspaceId &&
        record.sequence === request.sequence,
    );
    if (existing !== undefined) return existing;
    const record = {
      ...request,
      recordHash: request.sequence.toString(16).padStart(64, '0'),
      schemaVersion: 1 as const,
    };
    delete (record as { signal?: AbortSignal }).signal;
    this.records.push(record);
    if (this.hangAppend) await new Promise<never>(() => undefined);
    return record;
  }

  public async reconcile(request: {
    maxRecords: number;
    projectedHash: string;
    projectedSequence: number;
    signal?: AbortSignal;
    workspaceId: string;
  }) {
    await Promise.resolve();
    this.calls.push(`reconcile:${String(request.projectedSequence)}`);
    this.events?.push(`reconcile:${String(request.projectedSequence)}`);
    request.signal?.throwIfAborted();
    if (this.hangReconcile) await new Promise<never>(() => undefined);
    const limit = Math.min(
      request.maxRecords,
      this.pageSizeOverride ?? request.maxRecords,
    );
    const records = this.records
      .filter((record) => record.sequence > request.projectedSequence)
      .slice(0, limit);
    const last = records.at(-1);
    const hasMore = this.records.some(
      (record) =>
        record.sequence > (last?.sequence ?? request.projectedSequence),
    );
    return {
      hasMore,
      pageEndHash: last?.recordHash ?? request.projectedHash,
      pageEndSequence: last?.sequence ?? request.projectedSequence,
      reachedHighWater: !hasMore,
      records,
    };
  }
}

class OneSidedRepairLedger implements ControlLedger {
  public appendCalls = 0;
  public readonly reconcileRepairIds: (string | undefined)[] = [];
  public readonly recoveryRecords: ControlLedgerRecord[] = [];

  public constructor(public readonly primaryRecord: ControlLedgerRecord) {}

  public async append(
    request: AppendControlLedgerRecord,
  ): Promise<ControlLedgerRecord> {
    await Promise.resolve();
    this.appendCalls += 1;
    const { signal, ...material } = request;
    void signal;
    const { recordHash, schemaVersion, ...existingMaterial } =
      this.primaryRecord;
    void recordHash;
    void schemaVersion;
    if (JSON.stringify(material) !== JSON.stringify(existingMaterial)) {
      throw new ControlLedgerCommandConflictError();
    }
    this.recoveryRecords.push(this.primaryRecord);
    return this.primaryRecord;
  }

  public async reconcile(request: {
    maxRecords: number;
    projectedHash: string;
    projectedSequence: number;
    repairCommandId?: string;
    signal?: AbortSignal;
    workspaceId: string;
  }) {
    await Promise.resolve();
    this.reconcileRepairIds.push(request.repairCommandId);
    if (request.repairCommandId !== this.primaryRecord.commandId) {
      throw new ControlLedgerReconciliationError(
        'One-sided ledger tail does not match repair command',
      );
    }
    return {
      hasMore: false,
      pageEndHash: request.projectedHash,
      pageEndSequence: request.projectedSequence,
      reachedHighWater: true,
      records: [],
    };
  }
}

function fakeDatabase(
  events: string[],
  processId?: number,
  inventory: string[] = [workspaceId],
) {
  const releaseErrors: (Error | boolean | undefined)[] = [];
  const timeouts: string[] = [];
  let highWater = { hash: CONTROL_LEDGER_ZERO_HASH, sequence: 0 };
  const projections = new Map<string, ControlLedgerRecord>();
  let failProjection = false;
  let transactionProjectionSnapshot = new Map<string, ControlLedgerRecord>();
  let transactionHighWater = highWater;
  let enumerationCount = 0;
  let onEnumerate: ((count: number) => void) | undefined;
  const client = {
    ...(processId === undefined ? {} : { processID: processId }),
    query: async (
      queryInput:
        string | { text: string; values?: unknown[]; signal?: AbortSignal },
      positionalValues: unknown[] = [],
    ) => {
      await Promise.resolve();
      const text =
        typeof queryInput === 'string' ? queryInput : queryInput.text;
      const values =
        typeof queryInput === 'string'
          ? positionalValues
          : (queryInput.values ?? []);
      if (typeof queryInput !== 'string') queryInput.signal?.throwIfAborted();
      const normalized = text.trim().toLowerCase();
      if (normalized === 'begin') {
        events.push('BEGIN');
        transactionProjectionSnapshot = new Map(projections);
        transactionHighWater = { ...highWater };
      } else if (normalized.startsWith('set local')) {
        events.push('TIMEOUTS');
        timeouts.push(text);
      } else if (normalized.includes('lock_workspace_control_ledger')) {
        events.push('LOCK');
        return {
          rowCount: 1,
          rows: [
            {
              retention_control_hash: highWater.hash,
              retention_control_sequence: highWater.sequence,
            },
          ],
        };
      } else if (normalized.includes('enumerate_workspace_control_anchors')) {
        enumerationCount += 1;
        onEnumerate?.(enumerationCount);
        const after = typeof values[0] === 'string' ? values[0] : undefined;
        const limit = Number(values[1]);
        return {
          rowCount: null,
          rows: [...inventory]
            .sort()
            .filter((id) => after === undefined || id > after)
            .slice(0, limit)
            .map((id) => ({ workspace_id: id })),
        };
      } else if (normalized.includes('read_workspace_control_command')) {
        events.push('LOOKUP');
        const record = projections.get(String(values[1]));
        return {
          rowCount: record === undefined ? 0 : 1,
          rows:
            record === undefined
              ? []
              : [
                  {
                    actor_ref: record.actorRef,
                    command_id: record.commandId,
                    command_type: record.commandType,
                    legal_authority: record.legalAuthority ?? null,
                    occurred_at: record.occurredAt,
                    previous_hash: record.previousHash,
                    reason: record.reason,
                    record_hash: record.recordHash,
                    sequence: record.sequence,
                    subject_id: record.subjectId,
                  },
                ],
        };
      } else if (normalized.includes('validate_workspace_legal_hold_command')) {
        events.push('VALIDATE');
        const matching = [...projections.values()].filter(
          (record) => record.subjectId === String(values[2]),
        );
        const placement = matching.find(
          (record) => record.commandType === 'legal_hold_placed',
        );
        const released = matching.some(
          (record) => record.commandType === 'legal_hold_released',
        );
        if (values[1] === 'legal_hold_placed' && placement !== undefined)
          throw new Error('legal hold already exists');
        if (
          values[1] === 'legal_hold_released' &&
          (placement === undefined || released)
        )
          throw new Error('legal hold is absent or already released');
      } else if (normalized.includes('validate_workspace_deletion_command')) {
        events.push('VALIDATE');
      } else if (normalized.includes('project_workspace_')) {
        events.push('PROJECT');
        if (failProjection) throw new Error('projection failed');
        const record: ControlLedgerRecord = {
          workspaceId: String(values[0]),
          sequence: Number(values[1]),
          commandId: String(values[2]),
          commandType: values[3] as ControlLedgerRecord['commandType'],
          subjectId: String(values[4]),
          previousHash: String(values[5]),
          recordHash: String(values[6]),
          actorRef: String(values[7]),
          ...(typeof values[8] === 'string'
            ? { legalAuthority: values[8] }
            : {}),
          reason: String(values[9]),
          occurredAt: String(values[10]),
          schemaVersion: 1,
        };
        projections.set(record.commandId, record);
        highWater = { hash: record.recordHash, sequence: record.sequence };
        return { rowCount: 1, rows: [{ projected: true }] };
      } else if (normalized === 'commit') events.push('COMMIT');
      else if (normalized === 'rollback') {
        events.push('ROLLBACK');
        projections.clear();
        for (const [key, value] of transactionProjectionSnapshot)
          projections.set(key, value);
        highWater = transactionHighWater;
      }
      return { rowCount: null, rows: [] };
    },
    release: (error?: Error | boolean) => {
      releaseErrors.push(error);
      events.push('RELEASE');
    },
  } as unknown as PoolClient;
  return {
    pool: {
      connect: async () => {
        await Promise.resolve();
        return client;
      },
      end: async () => {
        await Promise.resolve();
      },
    },
    projections,
    releaseErrors,
    timeouts,
    setFailProjection(value: boolean) {
      failProjection = value;
    },
    setOnEnumerate(callback: (count: number) => void) {
      onEnumerate = callback;
    },
  };
}

function record(
  sequence: number,
  previousHash: string,
  overrides: Partial<ControlLedgerRecord> = {},
): ControlLedgerRecord {
  return {
    actorRef: 'operator:test',
    commandId: randomUUID(),
    commandType: 'legal_hold_placed',
    legalAuthority: 'case-123',
    occurredAt,
    previousHash,
    reason: 'Preserve records',
    recordHash: sequence.toString(16).padStart(64, '0'),
    schemaVersion: 1,
    sequence,
    subjectId: randomUUID(),
    workspaceId,
    ...overrides,
  };
}

describe('control ledger coordinator', () => {
  it('performs external I/O between short fenced transactions', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.events = events;
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      lockTimeoutMs: 1_234,
      pool: database.pool,
      statementTimeoutMs: 2_345,
    });

    await expect(coordinator.placeLegalHold(input())).resolves.toMatchObject({
      sequence: 1,
    });
    for (const externalEvent of ['reconcile:0', 'append']) {
      const index = events.indexOf(externalEvent);
      expect(events[index - 1]).toBe('RELEASE');
      expect(events.slice(index + 1)).toContain('BEGIN');
    }
    expect(events.indexOf('PROJECT')).toBeGreaterThan(events.indexOf('append'));
    expect(events.at(-2)).toBe('COMMIT');
    expect(events.at(-1)).toBe('RELEASE');
    expect(database.timeouts[0]).toContain("lock_timeout='1234ms'");
    expect(database.timeouts[0]).toContain("statement_timeout='2345ms'");
    expect(database.timeouts[0]).not.toContain(
      'idle_in_transaction_session_timeout',
    );
  });

  it('rolls back when append fails and leaves the projection unchanged', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.failAppend = true;
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });

    await expect(coordinator.placeLegalHold(input())).rejects.toThrow(
      'append failed',
    );
    expect(events).toContain('COMMIT');
    expect(events.at(-1)).toBe('RELEASE');
    expect(database.projections.size).toBe(0);
  });

  it('recovers an append-success projection failure on exact retry', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.events = events;
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });
    database.setFailProjection(true);
    await expect(coordinator.placeLegalHold(input())).rejects.toThrow(
      'projection failed',
    );
    expect(ledger.records).toHaveLength(1);

    database.setFailProjection(false);
    await expect(coordinator.placeLegalHold(input())).resolves.toMatchObject({
      replayed: true,
      sequence: 1,
    });
    expect(ledger.records).toHaveLength(1);
    expect(database.projections.size).toBe(1);
  });

  it('passes only the current command ID to heal an exact one-sided retry', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const pending = record(1, CONTROL_LEDGER_ZERO_HASH, {
      actorRef: 'operator:test',
      commandId,
      commandType: 'legal_hold_placed',
      legalAuthority: 'case-123',
      occurredAt,
      reason: 'Preserve records',
      subjectId: holdId,
    });
    const ledger = new OneSidedRepairLedger(pending);
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });

    await expect(coordinator.placeLegalHold(input())).resolves.toMatchObject({
      commandId,
      sequence: 1,
    });
    expect(ledger.reconcileRepairIds).toEqual([commandId]);
    expect(ledger.appendCalls).toBe(1);
    expect(ledger.recoveryRecords).toEqual([pending]);
    expect(database.projections.get(commandId)).toEqual(pending);
  });

  it('fails a different command before appending into a one-sided gap', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const pending = record(1, CONTROL_LEDGER_ZERO_HASH, {
      actorRef: 'operator:test',
      commandId,
      commandType: 'legal_hold_placed',
      legalAuthority: 'case-123',
      occurredAt,
      reason: 'Preserve records',
      subjectId: holdId,
    });
    const ledger = new OneSidedRepairLedger(pending);
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });
    const differentCommandId = randomUUID();

    await expect(
      coordinator.placeLegalHold(input({ commandId: differentCommandId })),
    ).rejects.toBeInstanceOf(ControlLedgerReconciliationError);
    expect(ledger.reconcileRepairIds).toEqual([differentCommandId]);
    expect(ledger.appendCalls).toBe(0);
    expect(ledger.recoveryRecords).toHaveLength(0);
  });

  it('reconciles a prior external command before appending a different command', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    await ledger.append({
      ...input({ commandId: randomUUID(), holdId: randomUUID() }),
      commandType: 'legal_hold_placed',
      previousHash: CONTROL_LEDGER_ZERO_HASH,
      sequence: 1,
      subjectId: randomUUID(),
    });
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });

    await expect(coordinator.placeLegalHold(input())).resolves.toMatchObject({
      sequence: 2,
    });
    expect(database.projections.size).toBe(2);
  });

  it('returns exact projected replay and rejects payload conflict without append', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });
    await coordinator.placeLegalHold(input());
    await expect(coordinator.placeLegalHold(input())).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      coordinator.placeLegalHold(input({ reason: 'Different reason' })),
    ).rejects.toBeInstanceOf(ControlLedgerCommandConflictError);
    expect(ledger.records).toHaveLength(1);
  });

  it('preflights invalid hold transitions before creating external records', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.events = events;
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });
    await coordinator.placeLegalHold(input());

    await expect(
      coordinator.placeLegalHold(input({ commandId: randomUUID() })),
    ).rejects.toThrow('legal hold already exists');
    await expect(
      coordinator.releaseLegalHold(
        input({ commandId: randomUUID(), holdId: randomUUID() }),
      ),
    ).rejects.toThrow('legal hold is absent or already released');
    await coordinator.releaseLegalHold(input({ commandId: randomUUID() }));
    await expect(
      coordinator.releaseLegalHold(input({ commandId: randomUUID() })),
    ).rejects.toThrow('legal hold is absent or already released');
    expect(ledger.records).toHaveLength(2);
    expect(events.indexOf('VALIDATE')).toBeLessThan(events.indexOf('append'));
  });

  it('reconciles authoritative deletion commands through the deletion projector', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    const deletionRecord = record(1, CONTROL_LEDGER_ZERO_HASH, {
      actorRef: randomUUID(),
      commandType: 'deletion_requested',
      subjectId: workspaceId,
    });
    delete (deletionRecord as { legalAuthority?: string }).legalAuthority;
    ledger.records.push(deletionRecord);
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });

    await expect(
      coordinator.reconcileWorkspace({ workspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 1, projectedCount: 1 });
    expect(events).toContain('PROJECT');
  });

  it('rolls back an aborted command and passes cancellation to the ledger', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      pool: database.pool,
    });

    await expect(
      coordinator.placeLegalHold(input({ signal: controller.signal })),
    ).rejects.toThrow('cancelled');
    expect(events).toEqual([]);
  });

  it('commits bounded reconciliation progress and reaches high water on retry', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.pageSizeOverride = 1;
    const first = record(1, CONTROL_LEDGER_ZERO_HASH);
    ledger.records.push(first);
    ledger.records.push(record(2, first.recordHash));
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      maxPages: 1,
      maxRecords: 1,
      pageSize: 1,
      pool: database.pool,
    });

    await expect(
      coordinator.reconcileWorkspace({ workspaceId }),
    ).rejects.toThrow('invocation bound exceeded');
    expect(events).toContain('COMMIT');
    expect(database.projections.size).toBe(1);
    await expect(
      coordinator.reconcileWorkspace({ workspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 2, projectedCount: 1 });
    expect(database.projections.size).toBe(2);
  });

  it('restarts inventory sweeps and catches a lower-sorting workspace', async () => {
    const events: string[] = [];
    const firstWorkspaceId = '80000000-0000-4000-8000-000000000000';
    const insertedWorkspaceId = '10000000-0000-4000-8000-000000000000';
    const inventory = [firstWorkspaceId];
    const database = fakeDatabase(events, undefined, inventory);
    database.setOnEnumerate((count) => {
      if (count === 3) inventory.push(insertedWorkspaceId);
    });
    const coordinator = createControlLedgerCoordinator(
      config,
      new MemoryLedger(),
      {
        inventoryPageSize: 1,
        maxInventoryPages: 4,
        maxInventorySweeps: 3,
        pool: database.pool,
      },
    );

    await expect(coordinator.reconcileAllWorkspaces()).resolves.toMatchObject({
      projectedRecordCount: 0,
      sweepCount: 3,
      workspaceCount: 2,
    });
  });

  it('requires a stable zero-projection sweep after a command arrives', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    database.setOnEnumerate((count) => {
      if (count !== 2) return;
      ledger.records.push(record(1, CONTROL_LEDGER_ZERO_HASH));
    });
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      maxInventorySweeps: 3,
      pool: database.pool,
    });

    await expect(coordinator.reconcileAllWorkspaces()).resolves.toMatchObject({
      projectedRecordCount: 1,
      sweepCount: 3,
      workspaceCount: 1,
    });
  });

  it('fails closed when the inventory cannot stabilize within its bound', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    database.setOnEnumerate((count) => {
      ledger.records.push(
        record(
          count,
          ledger.records.at(-1)?.recordHash ?? CONTROL_LEDGER_ZERO_HASH,
        ),
      );
    });
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      maxInventorySweeps: 2,
      pool: database.pool,
    });

    await expect(coordinator.reconcileAllWorkspaces()).rejects.toBeInstanceOf(
      ControlLedgerReconciliationError,
    );
  });

  it('commits backlog chunks before appending a command at proven high water', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.events = events;
    const first = record(1, CONTROL_LEDGER_ZERO_HASH);
    ledger.records.push(first, record(2, first.recordHash));
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      maxPages: 2,
      maxRecords: 2,
      pageSize: 1,
      pool: database.pool,
    });

    await expect(coordinator.placeLegalHold(input())).resolves.toMatchObject({
      sequence: 3,
    });
    expect(events.filter((event) => event === 'COMMIT').length).toBeGreaterThan(
      2,
    );
    expect(events.lastIndexOf('reconcile:2')).toBeLessThan(
      events.indexOf('append'),
    );
  });

  it('times out noncooperative reconciliation after releasing its transaction', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.hangReconcile = true;
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      externalOperationTimeoutMs: 1_000,
      pool: database.pool,
    });

    await expect(
      coordinator.reconcileWorkspace({ workspaceId }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(events).toContain('COMMIT');
    expect(events.at(-1)).toBe('RELEASE');
  });

  it('times out a noncooperative ambiguous append without local projection', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const ledger = new MemoryLedger();
    ledger.hangAppend = true;
    const coordinator = createControlLedgerCoordinator(config, ledger, {
      externalOperationTimeoutMs: 1_000,
      pool: database.pool,
    });

    await expect(coordinator.placeLegalHold(input())).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(ledger.records).toHaveLength(1);
    expect(database.projections.size).toBe(0);
    expect(events).toContain('COMMIT');
    expect(events.at(-1)).toBe('RELEASE');
    expect(events).not.toContain('PROJECT');
  });

  it('aborts external reconciliation after its prepare transaction closes', async () => {
    const events: string[] = [];
    const database = fakeDatabase(events, 12_345);
    const ledger = new MemoryLedger();
    ledger.hangReconcile = true;
    const controller = new AbortController();
    const reason = new Error('cancel without waiting for side channel');
    const coordinator = createControlLedgerCoordinator(
      {
        ...config,
        connectionString:
          'postgresql://maintenance:secret@10.255.255.1:5432/pertexo',
      },
      ledger,
      { pool: database.pool },
    );
    const pending = coordinator.reconcileWorkspace({
      signal: controller.signal,
      workspaceId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const abortedAt = performance.now();
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(performance.now() - abortedAt).toBeLessThan(500);
    expect(events.slice(-2)).toEqual(['COMMIT', 'RELEASE']);
    expect(database.releaseErrors.at(-1)).toBeUndefined();
  });

  it('aborts bounded pool acquisition promptly and releases the eventual client', async () => {
    let resolveClient: ((client: PoolClient) => void) | undefined;
    let released = false;
    const connection = new Promise<PoolClient>((resolve) => {
      resolveClient = resolve;
    });
    const pool = {
      connect: () => connection,
      end: async () => Promise.resolve(),
    };
    const controller = new AbortController();
    const reason = new Error('caller stopped waiting for the pool');
    const coordinator = createControlLedgerCoordinator(
      config,
      new MemoryLedger(),
      {
        pool,
      },
    );
    const pending = coordinator.reconcileWorkspace({
      signal: controller.signal,
      workspaceId,
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    resolveClient?.({
      release: () => (released = true),
    } as unknown as PoolClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(true);
  });

  it('rejects a page size above the artifact ledger contract', () => {
    expect(() =>
      createControlLedgerCoordinator(config, new MemoryLedger(), {
        pageSize: 101,
      }),
    ).toThrow();
  });
});
