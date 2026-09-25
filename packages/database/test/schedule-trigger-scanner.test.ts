import { createHash } from 'node:crypto';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  acceptWorkflowRun: vi.fn(),
  pools: [] as {
    close: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }[],
  workspaceTransaction: vi.fn(),
}));

// Admission itself is proven against PostgreSQL; here only its inputs and the
// completion the scanner records are observed, at exact database instants.
vi.mock('../src/execution/execution-acceptance.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  acceptWorkflowRun: (...arguments_: unknown[]) =>
    seams.acceptWorkflowRun(...arguments_) as Promise<unknown>,
}));
vi.mock(
  '../src/execution/published-workflow-reader.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    classifyPublishedWorkflowVersionRow: () => ({
      kind: 'v2_projection',
      workflowVersion: { id: '00000000-0000-4000-8000-000000000005' },
    }),
  }),
);
vi.mock(
  '../src/compatibility/compatibility-release.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    lockExpectedCompatibilityReleaseSet: () => Promise.resolve({ epoch: 1 }),
  }),
);

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
  onTimeWindowSeconds: 300,
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

type RecordedStatement = Readonly<{ sql: string; params: unknown[] }>;

const dialect = new PgDialect();
const runId = '00000000-0000-4000-8000-000000000008';

/** A workspace transaction that admits every eligible occurrence. */
function recordAdmissionTransactions(): RecordedStatement[] {
  const statements: RecordedStatement[] = [];
  seams.workspaceTransaction.mockImplementation(
    (
      _pool: unknown,
      _workspaceId: unknown,
      operation: (transaction: unknown) => Promise<unknown>,
    ) =>
      operation({
        db: {
          execute: (statement: SQL) => {
            const query = dialect.sqlToQuery(statement);
            statements.push(query);
            if (query.sql.includes('schedule_claim_is_eligible'))
              return Promise.resolve({ rows: [{ eligible: true }] });
            if (query.sql.includes('complete_trigger_schedule_claim'))
              return Promise.resolve({ rows: [{ completed: true }] });
            return Promise.resolve({ rows: [{}] });
          },
        },
      }),
  );
  return statements;
}

/** Scheduled instant, disposition, run and next fire the claim completed with. */
function completion(statements: readonly RecordedStatement[]) {
  const completed = statements.filter(({ sql }) =>
    sql.includes('complete_trigger_schedule_claim'),
  );
  expect(completed).toHaveLength(1);
  const [, , , scheduledAt, disposition, completedRunId, nextAt] =
    completed[0]?.params ?? [];
  return { scheduledAt, disposition, runId: completedRunId, nextAt };
}

function hourlyClaim(policy: 'catch_up_once' | 'skip', observedAt: string) {
  return claim(ids.triggerOne, ids.leaseOne, {
    interval_minutes: 60,
    misfire_policy: policy,
    anchor_at: new Date('2026-01-01T00:00:00.000Z'),
    next_fire_at: new Date('2026-01-01T01:00:00.000Z'),
    observed_at: new Date(observedAt),
  });
}

describe('schedule misfire disposition (ADR 049)', () => {
  beforeEach(() => {
    seams.pools.length = 0;
    seams.workspaceTransaction.mockReset();
    seams.acceptWorkflowRun.mockReset();
    seams.acceptWorkflowRun.mockResolvedValue({ runId });
  });

  it.each([
    ['skip', '2026-01-01T01:05:00.000Z', 'accepted'],
    ['skip', '2026-01-01T01:05:00.001Z', 'skipped'],
    ['catch_up_once', '2026-01-01T01:59:59.999Z', 'accepted'],
  ] as const)(
    'decides a %s occurrence observed at %s as %s',
    async (policy, observedAt, disposition) => {
      const statements = recordAdmissionTransactions();
      const { scanner } = scannerWithClaims([hourlyClaim(policy, observedAt)]);

      await expect(scanner.scanDue(scanInput)).resolves.toMatchObject({
        claimed: 1,
        accepted: disposition === 'accepted' ? 1 : 0,
        skipped: disposition === 'skipped' ? 1 : 0,
        deferred: 0,
      });
      expect(completion(statements)).toEqual({
        scheduledAt: new Date('2026-01-01T01:00:00.000Z'),
        disposition,
        runId: disposition === 'accepted' ? runId : null,
        nextAt: new Date('2026-01-01T02:00:00.000Z'),
      });
      expect(
        statements.some(({ sql }) =>
          sql.includes('schedule_claim_is_eligible'),
        ),
      ).toBe(disposition === 'accepted');
      expect(seams.acceptWorkflowRun).toHaveBeenCalledTimes(
        disposition === 'accepted' ? 1 : 0,
      );
    },
  );

  it('admits an on-time skip occurrence exactly as catch-up admits it', async () => {
    const identity = `${ids.triggerOne}:2026-01-01T01:00:00.000Z`;
    for (const policy of ['skip', 'catch_up_once'] as const) {
      recordAdmissionTransactions();
      const { scanner } = scannerWithClaims([
        hourlyClaim(policy, '2026-01-01T01:00:01.000Z'),
      ]);
      await expect(scanner.scanDue(scanInput)).resolves.toMatchObject({
        accepted: 1,
      });
    }

    const [skipInput, catchUpInput] = seams.acceptWorkflowRun.mock.calls.map(
      ([, input]: unknown[]) => input,
    );
    expect(skipInput).toEqual(catchUpInput);
    expect(skipInput).toMatchObject({
      keyHash: createHash('sha256').update(identity).digest('hex'),
      scope: `schedule:${ids.triggerOne}`,
      triggerType: 'schedule',
      runInput: { scheduledAt: '2026-01-01T01:00:00.000Z' },
    });
  });

  it.each([
    // 02:30 does not exist on 10 March 2030 in New York: the occurrence is
    // the first valid instant after the gap, and lateness counts from there.
    [
      '30 2 * * *',
      '2030-03-10T07:05:00.000Z',
      '2030-03-10T07:00:00.000Z',
      'accepted',
    ],
    [
      '30 2 * * *',
      '2030-03-10T07:05:00.001Z',
      '2030-03-10T07:00:00.000Z',
      'skipped',
    ],
    // 01:30 happens twice on 3 November 2030: the occurrence is the earlier
    // instant, so seeing the repeated wall-clock time an hour on is late.
    [
      '30 1 * * *',
      '2030-11-03T05:35:00.000Z',
      '2030-11-03T05:30:00.000Z',
      'accepted',
    ],
    [
      '30 1 * * *',
      '2030-11-03T06:31:00.000Z',
      '2030-11-03T05:30:00.000Z',
      'skipped',
    ],
  ] as const)(
    'measures %s in New York observed at %s from its DST-resolved instant',
    async (expression, observedAt, scheduledAt, disposition) => {
      const statements = recordAdmissionTransactions();
      const { scanner } = scannerWithClaims([
        claim(ids.triggerOne, ids.leaseOne, {
          recurrence_kind: 'cron',
          cron_expression: expression,
          timezone: 'America/New_York',
          interval_minutes: null,
          misfire_policy: 'skip',
          anchor_at: new Date(
            expression === '30 2 * * *'
              ? '2030-03-09T12:00:00.000Z'
              : '2030-11-02T12:00:00.000Z',
          ),
          next_fire_at: new Date(scheduledAt),
          observed_at: new Date(observedAt),
        }),
      ]);

      await scanner.scanDue(scanInput);
      expect(completion(statements)).toMatchObject({
        scheduledAt: new Date(scheduledAt),
        disposition,
      });
      expect(seams.acceptWorkflowRun).toHaveBeenCalledTimes(
        disposition === 'accepted' ? 1 : 0,
      );
    },
  );

  it.each([59, 3_601, 300.5])(
    'rejects an on-time window of %s seconds before claiming',
    async (onTimeWindowSeconds) => {
      const { queries, scanner } = scannerWithClaims([
        hourlyClaim('skip', '2026-01-01T01:00:01.000Z'),
      ]);

      await expect(
        scanner.scanDue({ ...scanInput, onTimeWindowSeconds }),
      ).rejects.toThrow();
      expect(queries).toEqual([]);
      expect(seams.workspaceTransaction).not.toHaveBeenCalled();
    },
  );
});
