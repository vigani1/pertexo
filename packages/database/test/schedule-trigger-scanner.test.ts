import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  pools: [] as {
    close: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }[],
  workspaceTransaction: vi.fn(),
}));

vi.mock('../src/platform/database-runtime.js', () => ({
  acquireDatabasePool: () => {
    const pool = seams.pools.shift();
    if (pool === undefined) throw new Error('Unexpected pool acquisition');
    return { pool, close: pool.close };
  },
}));

vi.mock('../src/tenant-access/workspace.js', () => ({
  withPlatformTransaction: async (
    pool: { query: (...arguments_: unknown[]) => Promise<unknown> },
    operation: (client: {
      query: (...arguments_: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>,
    options: { signal?: AbortSignal } = {},
  ) => {
    options.signal?.throwIfAborted();
    return operation({ query: (...arguments_) => pool.query(...arguments_) });
  },
  withWorkspaceTransaction: (...arguments_: unknown[]) =>
    seams.workspaceTransaction(...arguments_) as Promise<unknown>,
}));

import type { DatabaseConfig } from '../src/config.js';
import { createScheduleTriggerScanner } from '../src/triggers/schedule-trigger-scanner.js';

const claimConfig = {
  connectionString: 'postgresql://worker:secret@db/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} satisfies DatabaseConfig;
const acceptanceConfig = {
  ...claimConfig,
  connectionString: 'postgresql://api:secret@db/pertexo',
} satisfies DatabaseConfig;
const release = Object.freeze({
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  catalogJson:
    '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
});

const ids = Object.freeze({
  triggerOne: '00000000-0000-4000-8000-000000000001',
  triggerTwo: '00000000-0000-4000-8000-000000000002',
  workspace: '00000000-0000-4000-8000-000000000003',
  workflow: '00000000-0000-4000-8000-000000000004',
  version: '00000000-0000-4000-8000-000000000005',
  leaseOne: '00000000-0000-4000-8000-000000000006',
  leaseTwo: '00000000-0000-4000-8000-000000000007',
});

function claim(
  triggerId: string,
  leaseToken: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const observedAt = new Date('2026-01-01T00:10:00.000Z');
  return {
    trigger_id: triggerId,
    workspace_id: ids.workspace,
    workflow_id: ids.workflow,
    workflow_version_id: ids.version,
    node_id: `schedule-${triggerId}`,
    recurrence_kind: 'interval',
    cron_expression: null,
    timezone: null,
    interval_minutes: 1,
    misfire_policy: 'catch_up_once',
    config_fingerprint: 'trigger:fingerprint',
    anchor_at: new Date('2026-01-01T00:00:00.000Z'),
    next_fire_at: new Date('2026-01-01T00:01:00.000Z'),
    lease_token: leaseToken,
    observed_at: observedAt,
    ...overrides,
  };
}

function scannerWithClaims(
  rows: readonly Record<string, unknown>[],
  cleanup?: (
    statement: string,
    parameters: readonly unknown[] | undefined,
  ) => Promise<unknown>,
) {
  const queries: (readonly [string, readonly unknown[] | undefined])[] = [];
  const claimPool = {
    close: vi.fn(() => Promise.resolve()),
    query: vi.fn(
      async (statement: unknown, parameters?: readonly unknown[]) => {
        const text = String(statement);
        queries.push([text, parameters]);
        if (text.includes('claim_due_trigger_schedules'))
          return { rowCount: rows.length, rows };
        if (cleanup !== undefined) return cleanup(text, parameters);
        return {
          rowCount: 1,
          rows: [{ release_trigger_schedule_claim: true }],
        };
      },
    ),
  };
  seams.pools.push(claimPool, {
    close: vi.fn(() => Promise.resolve()),
    query: vi.fn(),
  });
  return {
    queries,
    scanner: createScheduleTriggerScanner(
      claimConfig,
      release,
      acceptanceConfig,
    ),
  };
}

const scanInput = {
  leaseOwner: 'scanner-test',
  limit: 10,
  leaseSeconds: 30,
  checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
} as const;

describe('schedule trigger scanner claim ownership', () => {
  beforeEach(() => {
    seams.pools.length = 0;
    seams.workspaceTransaction.mockReset();
  });

  it('performs no claim work for a pre-aborted scan', async () => {
    const reason = new Error('stop before checkout');
    const controller = new AbortController();
    controller.abort(reason);
    const { queries, scanner } = scannerWithClaims([]);

    await expect(
      scanner.scanDue({ ...scanInput, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(queries).toEqual([]);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('never cleans up a malformed identity and releases every valid sibling', async () => {
    const malformed = claim('not-a-uuid', ids.leaseOne);
    const valid = claim(ids.triggerTwo, ids.leaseTwo);
    const { queries, scanner } = scannerWithClaims([malformed, valid]);

    await expect(scanner.scanDue(scanInput)).rejects.toThrow();
    expect(
      queries.filter(([text]) =>
        text.includes('release_trigger_schedule_claim'),
      ),
    ).toEqual([
      [
        expect.stringContaining('release_trigger_schedule_claim'),
        [ids.triggerTwo, ids.leaseTwo],
      ],
    ]);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('preserves recurrence failure while attempting fail then later release', async () => {
    const failure = new Error('fail cleanup unavailable');
    const { queries, scanner } = scannerWithClaims(
      [
        claim(ids.triggerOne, ids.leaseOne, {
          recurrence_kind: 'cron',
          cron_expression: 'invalid',
          timezone: 'UTC',
          interval_minutes: null,
        }),
        claim(ids.triggerTwo, ids.leaseTwo),
      ],
      (statement) =>
        statement.includes('fail_trigger_schedule_claim')
          ? Promise.reject(failure)
          : Promise.resolve({ rowCount: 1, rows: [] }),
    );

    await expect(scanner.scanDue(scanInput)).rejects.toThrow(
      'Invalid schedule recurrence',
    );
    expect(
      queries
        .filter(([text]) => text.includes('trigger_schedule_claim'))
        .map(([text]) =>
          text.includes('fail_trigger_schedule_claim') ? 'fail' : 'release',
        ),
    ).toEqual(['fail', 'release']);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('stops admission between rows and releases every remaining claim', async () => {
    const reason = new Error('stop between rows');
    const controller = new AbortController();
    let releaseCount = 0;
    const { queries, scanner } = scannerWithClaims(
      [
        claim(ids.triggerOne, ids.leaseOne, {
          anchor_at: new Date('2026-01-01T00:10:00.000Z'),
          next_fire_at: new Date('2026-01-01T00:11:00.000Z'),
        }),
        claim(ids.triggerTwo, ids.leaseTwo),
      ],
      (statement) => {
        if (statement.includes('release_trigger_schedule_claim')) {
          releaseCount += 1;
          if (releaseCount === 1) controller.abort(reason);
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      },
    );

    await expect(
      scanner.scanDue({ ...scanInput, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(releaseCount).toBe(2);
    expect(
      queries
        .filter(([text]) => text.includes('release_trigger_schedule_claim'))
        .map(([, parameters]) => parameters?.[0]),
    ).toEqual([ids.triggerOne, ids.triggerTwo]);
    expect(seams.workspaceTransaction).not.toHaveBeenCalled();
  });

  it('preserves acceptance failure when fail cleanup rejects and retires later rows', async () => {
    const primary = new Error('checkpoint failed');
    seams.workspaceTransaction.mockRejectedValueOnce(primary);
    const { queries, scanner } = scannerWithClaims(
      [
        claim(ids.triggerOne, ids.leaseOne),
        claim(ids.triggerTwo, ids.leaseTwo),
      ],
      (statement) =>
        statement.includes('fail_trigger_schedule_claim')
          ? Promise.reject(new Error('fail cleanup rejected'))
          : Promise.resolve({ rowCount: 1, rows: [] }),
    );

    await expect(scanner.scanDue(scanInput)).rejects.toBe(primary);
    expect(
      queries
        .filter(([text]) => text.includes('trigger_schedule_claim'))
        .map(([text]) =>
          text.includes('fail_trigger_schedule_claim') ? 'fail' : 'release',
        ),
    ).toEqual(['fail', 'release']);
    expect(seams.workspaceTransaction).toHaveBeenCalledOnce();
  });
});
