import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { requestText } from '../../../support/postgres/query-text.js';
import { claimSchema } from '../../../../src/triggers/schedules/scanning/input.js';
import { expect, vi } from 'vitest';
import type { DatabaseConfig } from '../../../../src/config.js';
import { createScheduleTriggerScanner } from '../../../../src/triggers/schedules/scanner.js';

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
vi.mock(
  '../../../../src/runs/commands/acceptance.repository.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    acceptWorkflowRun: (...arguments_: unknown[]) =>
      seams.acceptWorkflowRun(...arguments_) as Promise<unknown>,
  }),
);

vi.mock('../../../../src/platform/pool/runtime.js', () => ({
  acquireDatabasePool: () => {
    const pool = seams.pools.shift();
    if (pool === undefined) throw new Error('Unexpected pool acquisition');
    return { pool, close: pool.close };
  },
}));

vi.mock('../../../../src/tenant-access/transactions.js', () => ({
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

const claimConfig = {
  connectionString: 'postgresql://worker:secret@db/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 2,
  ownerRole: 'pertexo_owner',
} satisfies DatabaseConfig;

const acceptanceConfig = {
  ...claimConfig,
  connectionString: 'postgresql://api:secret@db/pertexo',
} satisfies DatabaseConfig;

export const ids = Object.freeze({
  triggerOne: '00000000-0000-4000-8000-000000000001',
  triggerTwo: '00000000-0000-4000-8000-000000000002',
  workspace: '00000000-0000-4000-8000-000000000003',
  workflow: '00000000-0000-4000-8000-000000000004',
  version: '00000000-0000-4000-8000-000000000005',
  leaseOne: '00000000-0000-4000-8000-000000000006',
  leaseTwo: '00000000-0000-4000-8000-000000000007',
});

export function claim(
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

export function scannerWithClaims(
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
        const text = requestText(statement);
        queries.push([text, parameters]);
        if (text.includes('claim_due_trigger_schedules'))
          return {
            rowCount: rows.length,
            rows: rows.map((row) =>
              Object.keys(claimSchema.shape).map((key) => row[key]),
            ),
          };
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
    scanner: createScheduleTriggerScanner(claimConfig, acceptanceConfig),
  };
}

export const scanInput = {
  leaseOwner: 'scanner-test',
  limit: 10,
  leaseSeconds: 30,
  onTimeWindowSeconds: 300,
  checkpointFactory: () => ({ checkpoint: {} }),
} as const;

type RecordedStatement = Readonly<{ sql: string; params: unknown[] }>;

export const runId = '00000000-0000-4000-8000-000000000008';

/** A workspace transaction that admits every eligible occurrence. */
export function recordAdmissionTransactions(): RecordedStatement[] {
  const statements: RecordedStatement[] = [];
  seams.workspaceTransaction.mockImplementation(
    (
      _pool: unknown,
      workspaceId: unknown,
      operation: (transaction: unknown) => Promise<unknown>,
    ) =>
      operation({
        workspaceId,
        db: drizzle(
          Object.assign(new Client(), {
            query: (request: unknown, params: unknown[] = []) => {
              const text = requestText(request).replaceAll('"', '');
              statements.push({ sql: text, params });
              if (text.includes('for share of workflow'))
                return Promise.resolve({
                  rows: [[ids.workflow, false]],
                  rowCount: 1,
                });
              if (text.includes('from app.workflow_trigger_pause_periods'))
                return Promise.resolve({ rows: [[false]], rowCount: 1 });
              if (text.includes('from app.workflow_versions'))
                return Promise.resolve({
                  rows: [
                    [
                      ids.version,
                      ids.workspace,
                      ids.workflow,
                      1,
                      'wf:sha256:' + '0'.repeat(64),
                      {},
                    ],
                  ],
                  rowCount: 1,
                });
              return Promise.resolve({ rows: [[1]], rowCount: 1 });
            },
          }),
        ),
      }),
  );
  return statements;
}

/** Scheduled instant, disposition, run and next fire the claim completed with. */
export function completion(statements: readonly RecordedStatement[]) {
  const recorded = statements.filter(({ sql }) =>
    sql.includes('insert into app.trigger_schedule_occurrences'),
  );
  const moved = statements.filter(({ sql }) =>
    sql.includes('update app.trigger_schedules'),
  );
  expect(recorded).toHaveLength(1);
  expect(moved).toHaveLength(1);
  const [, , , scheduledAt, disposition, , completedRunId] =
    recorded[0]?.params ?? [];
  const [nextAt] = moved[0]?.params ?? [];
  return {
    scheduledAt: parameterDate(scheduledAt),
    disposition,
    runId: completedRunId,
    nextAt: parameterDate(nextAt),
  };
}

export function hourlyClaim(
  policy: 'catch_up_once' | 'skip',
  observedAt: string,
) {
  return claim(ids.triggerOne, ids.leaseOne, {
    interval_minutes: 60,
    misfire_policy: policy,
    anchor_at: new Date('2026-01-01T00:00:00.000Z'),
    next_fire_at: new Date('2026-01-01T01:00:00.000Z'),
    observed_at: new Date(observedAt),
  });
}

export function beforeEachFixture1() {
  seams.pools.length = 0;
  seams.workspaceTransaction.mockReset();
}

export function beforeEachFixture2() {
  seams.pools.length = 0;
  seams.workspaceTransaction.mockReset();
  seams.acceptWorkflowRun.mockReset();
  seams.acceptWorkflowRun.mockResolvedValue({ runId });
}

export { seams };

// The builder encodes timestamps before handing parameters to the pg driver.
function parameterDate(value: unknown): Date {
  if (typeof value !== 'string' && !(value instanceof Date))
    throw new Error('Expected a timestamp parameter');
  return new Date(value);
}
