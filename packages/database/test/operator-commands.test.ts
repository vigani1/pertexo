import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  checkReadiness: vi.fn(),
  close: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  transactionDecoded: vi.fn(),
}));

vi.mock('../src/operator/operator-command-runtime.js', () => ({
  createOperatorCommandRuntime: vi.fn(() => runtime),
}));

import { createOperatorCommandDatabase } from '../src/operator/operator-commands.js';

const config = {
  connectionString: 'postgresql://operator.invalid/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const workspaceId = randomUUID();
const actorRef = 'operator:test';
const reason = 'Exercise explicit operator mapping';
const base = Object.freeze({
  actorRef,
  commandId: randomUUID(),
  dryRun: false,
  reason,
  workspaceId,
});
const getInput = Object.freeze({
  actorRef,
  commandId: base.commandId,
  reason,
  workspaceId,
});

function database() {
  return createOperatorCommandDatabase(config);
}

describe('operator command facade mappings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.execute.mockResolvedValue({
      commandId: base.commandId,
      outcome: 'completed',
      replayed: false,
      result: {},
      status: 'completed',
    });
    runtime.transactionDecoded.mockResolvedValue({
      conflict: false,
      result: {
        commandId: base.commandId,
        outcome: 'redispatched',
        replayed: false,
        status: 'completed',
      },
    });
  });

  it.each([
    {
      invoke: () => database().cancelRun({ ...base, runId: randomUUID() }),
      sql: 'cancel_operator_run',
      values: () => [
        base.commandId,
        workspaceId,
        expect.any(String) as unknown,
        actorRef,
        reason,
        false,
      ],
    },
    {
      invoke: () =>
        database().reconcileAttempt({
          ...base,
          action: 'reclaim',
          attemptId: randomUUID(),
          expectedFenceToken: 7,
        }),
      sql: 'reconcile_operator_attempt',
      values: () => [
        base.commandId,
        workspaceId,
        expect.any(String) as unknown,
        7,
        'reclaim',
        actorRef,
        reason,
        false,
      ],
    },
    {
      invoke: () => database().resumeDueWork({ ...base, runId: randomUUID() }),
      sql: 'resume_operator_due_work',
      values: () => [
        base.commandId,
        workspaceId,
        expect.any(String) as unknown,
        actorRef,
        reason,
        false,
      ],
    },
    {
      invoke: () =>
        database().requestMaintenanceRerun({
          ...base,
          targetId: randomUUID(),
          targetType: 'retention_batch',
        }),
      sql: 'request_operator_maintenance_rerun',
      values: () => [
        base.commandId,
        workspaceId,
        'retention_batch',
        expect.any(String) as unknown,
        actorRef,
        reason,
        false,
      ],
    },
    {
      invoke: () =>
        database().retryTriggerReconciliation({
          ...base,
          workflowId: randomUUID(),
        }),
      sql: 'retry_operator_trigger_reconciliation',
      values: () => [
        base.commandId,
        workspaceId,
        expect.any(String) as unknown,
        actorRef,
        reason,
        false,
      ],
    },
  ])('maps $sql arguments in their explicit order', async (scenario) => {
    await scenario.invoke();
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(runtime.execute.mock.calls[0]?.[0]).toContain(scenario.sql);
    expect(runtime.execute.mock.calls[0]?.[1]).toEqual(scenario.values());
  });

  it('maps replay and evidence JSON as stable accepted snapshots', async () => {
    const sourceRunId = randomUUID();
    const workflowVersionId = randomUUID();
    const replay = { z: 2, a: { value: true } };
    await database().replayRun({
      ...base,
      runInput: replay,
      sourceRunId,
      workflowVersionId,
    });
    expect(runtime.execute.mock.calls[0]?.[0]).toContain(
      'request_operator_run_replay',
    );
    expect(runtime.execute.mock.calls[0]?.[1]).toEqual([
      base.commandId,
      workspaceId,
      sourceRunId,
      workflowVersionId,
      '{"a":{"value":true},"z":2}',
      actorRef,
      reason,
      false,
    ]);

    runtime.execute.mockClear();
    const attemptId = randomUUID();
    await database().recordUnknownOutcomeEvidence({
      actorRef,
      attemptId,
      commandId: base.commandId,
      evidenceKind: 'provider.receipt',
      evidenceRef: { z: 2, a: 'accepted' },
      reason,
      workspaceId,
    });
    expect(runtime.execute.mock.calls[0]?.[1]).toEqual([
      base.commandId,
      workspaceId,
      attemptId,
      'provider.receipt',
      '{"a":"accepted","z":2}',
      actorRef,
      reason,
    ]);
  });

  it('maps redispatch and get through pre-COMMIT decoders', async () => {
    const outboxEventId = randomUUID();
    await database().redispatchFailedOutbox({ ...base, outboxEventId });
    expect(runtime.transactionDecoded.mock.calls[0]?.[0]).toContain(
      'redispatch_failed_outbox_event',
    );
    expect(runtime.transactionDecoded.mock.calls[0]?.[1]).toEqual([
      base.commandId,
      workspaceId,
      outboxEventId,
      actorRef,
      reason,
      false,
    ]);

    runtime.transactionDecoded.mockClear();
    await database().getCommand(getInput);
    expect(runtime.transactionDecoded.mock.calls[0]?.[0]).toContain(
      'get_operator_command',
    );
    expect(runtime.transactionDecoded.mock.calls[0]?.[1]).toEqual([
      base.commandId,
      workspaceId,
      actorRef,
      reason,
    ]);
  });
});

describe('bounded operator JSON', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.execute.mockResolvedValue({
      commandId: base.commandId,
      outcome: 'completed',
      replayed: false,
      result: {},
      status: 'completed',
    });
  });

  const replay = (runInput: unknown) =>
    database().replayRun({
      ...base,
      runInput,
      sourceRunId: randomUUID(),
      workflowVersionId: randomUUID(),
    });

  it('accepts exact byte limits and rejects one byte over with Unicode accounting', async () => {
    await expect(replay('a'.repeat(65_534))).resolves.toBeDefined();
    await expect(replay('a'.repeat(65_535))).rejects.toThrow(
      'Operator replay input must not exceed 65536 UTF-8 bytes',
    );
    await expect(replay('é'.repeat(32_767))).resolves.toBeDefined();
    await expect(replay('é'.repeat(32_768))).rejects.toThrow(
      'Operator replay input must not exceed 65536 UTF-8 bytes',
    );

    const evidenceAtLimit = { value: 'a'.repeat(4084) };
    const evidenceOverLimit = { value: 'a'.repeat(4085) };
    await expect(
      database().recordUnknownOutcomeEvidence({
        actorRef,
        attemptId: randomUUID(),
        commandId: base.commandId,
        evidenceKind: 'provider.receipt',
        evidenceRef: evidenceAtLimit,
        reason,
        workspaceId,
      }),
    ).resolves.toBeDefined();
    await expect(
      database().recordUnknownOutcomeEvidence({
        actorRef,
        attemptId: randomUUID(),
        commandId: base.commandId,
        evidenceKind: 'provider.receipt',
        evidenceRef: evidenceOverLimit,
        reason,
        workspaceId,
      }),
    ).rejects.toThrow(
      'Unknown outcome evidence must not exceed 4096 UTF-8 bytes',
    );
  });

  it('permits aliases but rejects cycles, depth overflow, and unsupported values before authority', async () => {
    const shared = { value: 1 };
    await expect(replay([shared, shared])).resolves.toBeDefined();

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 65; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    for (const invalid of [cyclic, deep, undefined, 1n, () => undefined])
      await expect(replay(invalid)).rejects.toBeInstanceOf(TypeError);

    expect(runtime.execute).toHaveBeenCalledOnce();
  });

  it('rejects getters, proxies, symbols, and toJSON hooks without invoking them', async () => {
    const getter = vi.fn();
    const toJSON = vi.fn();
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: getter,
    });
    const withHook = { value: 1, toJSON };
    const withSymbol = { value: 1, [Symbol('hidden')]: true };
    const proxy = new Proxy(
      { value: 1 },
      {
        ownKeys: () => {
          throw new Error('proxy trap ran');
        },
      },
    );

    for (const invalid of [accessor, withHook, withSymbol, proxy])
      await expect(replay(invalid)).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
  });
});

describe('operator command row decoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function decodeRows(rows: readonly Record<string, unknown>[]) {
    runtime.transactionDecoded.mockImplementation(
      (_text, _values, decode: (value: { rows: typeof rows }) => unknown) =>
        Promise.resolve(decode({ rows })),
    );
  }

  it('returns null for no row and rejects invalid persisted dates', async () => {
    decodeRows([]);
    await expect(database().getCommand(getInput)).resolves.toBeNull();

    decodeRows([
      {
        command_id: base.commandId,
        command_type: 'outbox.redispatch',
        completed_at: null,
        created_at: 'not-a-date',
        dry_run: false,
        command_outcome: 'redispatched',
        command_status: 'completed',
        request_fingerprint: 'a'.repeat(64),
        result: {},
      },
    ]);
    await expect(database().getCommand(getInput)).rejects.toThrow();
  });

  it('decodes valid nullable and result dates without creating Invalid Date', async () => {
    decodeRows([
      {
        command_id: base.commandId,
        command_type: 'outbox.redispatch',
        completed_at: '2026-09-13T12:00:00.000Z',
        created_at: new Date('2026-09-13T11:00:00.000Z'),
        dry_run: false,
        command_outcome: 'redispatched',
        command_status: 'completed',
        request_fingerprint: 'a'.repeat(64),
        result: {
          priorErrorCode: 'provider.failed',
          priorFailedAt: '2026-09-13T10:00:00.000Z',
          priorPublishAttempts: '3',
        },
      },
    ]);
    const result = await database().getCommand(getInput);
    expect(result).toMatchObject({
      priorErrorCode: 'provider.failed',
      priorPublishAttempts: 3,
    });
    expect(result?.createdAt.toISOString()).toBe('2026-09-13T11:00:00.000Z');
    expect(result?.completedAt?.toISOString()).toBe('2026-09-13T12:00:00.000Z');
    expect(result?.priorFailedAt?.toISOString()).toBe(
      '2026-09-13T10:00:00.000Z',
    );
  });
});
