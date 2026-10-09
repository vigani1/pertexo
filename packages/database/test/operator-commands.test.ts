import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const transaction = vi.hoisted(() => vi.fn());

vi.mock('../src/tenant-access/transactions.js', () => ({
  withWorkspaceTransaction: transaction,
}));

import { createOperatorCommandDatabase } from '../src/operator/operator-commands.js';

const config = {
  connectionString: 'postgresql://operator.invalid/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner',
} as const;

const workspaceId = randomUUID();
const actorRef = 'operator:test';
const reason = 'Exercise bounded operator input';
const base = Object.freeze({
  actorRef,
  commandId: randomUUID(),
  dryRun: false,
  reason,
  workspaceId,
});

function database() {
  return createOperatorCommandDatabase(config);
}

describe('bounded operator JSON', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockResolvedValue({
      commandId: base.commandId,
      outcome: 'would_request',
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

    expect(transaction).toHaveBeenCalledOnce();
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
    expect(transaction).not.toHaveBeenCalled();
  });
});
