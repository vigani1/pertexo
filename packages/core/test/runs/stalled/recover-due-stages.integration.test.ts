import { randomUUID } from 'node:crypto';

import {
  acquireDatabasePool,
  createDatabaseRuntime,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createStalledWorkStore,
  type StalledWorkStore,
} from '../../../src/runs/index.js';
import { claimDispatchAttempt } from '../run-store/node-attempts/fixture.js';
import {
  asAdmin,
  canonicalOutboxPayloadChecksum,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  workspaceA,
} from '../run-store/fixtures.js';

const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

type Stage = 'expired_leases' | 'overdue_deliveries' | 'failed_run_jobs';

/** What each stage reads first, for that one statement to fail. */
const STAGE_STATEMENT: Readonly<Record<Stage, RegExp>> = {
  expired_leases: /from "app"\."node_attempts"/u,
  overdue_deliveries: /with due as materialized/u,
  failed_run_jobs: /"job_name" in/u,
};

const STAGES = Object.keys(STAGE_STATEMENT) as readonly Stage[];

/** Answers one statement itself: PostgreSQL stays real for every other. */
const interceptQueries = (
  pool: Pool,
  answer: (text: string, forward: () => unknown) => unknown,
): void => {
  type Query = (...values: unknown[]) => unknown;
  const query = pool.query.bind(pool) as Query;
  vi.spyOn(pool as unknown as { query: Query }, 'query').mockImplementation(
    (...values) =>
      answer(
        typeof values[0] === 'string'
          ? values[0]
          : (values[0] as { text: string }).text,
        () => query(...values),
      ),
  );
};

const failStatement = (pool: Pool, statement: RegExp, error: Error): void => {
  interceptQueries(pool, (text, forward) =>
    statement.test(text) ? Promise.reject(error) : forward(),
  );
};

async function insertEvent(input: {
  jobName: string;
  aggregateType: string;
  aggregateId: string;
  failed: boolean;
}): Promise<string> {
  const id = randomUUID();
  const payload = { workspaceId: workspaceA, outboxEventId: id };
  await asAdmin((client) =>
    client.query(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,
         published_at,failed_at,last_error_code,delivery_due_at
       ) values (
         $1,$2,$3,$4,$5,$6::jsonb,$7,
         case when $8 then null else clock_timestamp() end,
         case when $8 then clock_timestamp() end,
         case when $8 then 'delivery.never_confirmed' end,
         clock_timestamp() - interval '1 second'
       )`,
      [
        id,
        workspaceA,
        input.jobName,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(payload),
        canonicalOutboxPayloadChecksum(payload),
        input.failed,
      ],
    ),
  );
  return id;
}

/** A row due for each stage, so what a stage did shows in what it left behind. */
async function seedOneForEachStage() {
  const lease = await claimDispatchAttempt(`stage-${randomUUID()}`, {
    sideEffectClass: 'safe',
  });
  await asAdmin((client) =>
    client.query(
      `update app.node_attempts
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [lease.attemptId],
    ),
  );
  const overdueEventId = await insertEvent({
    jobName: 'deliver-workspace-invitation',
    aggregateType: 'workspace-invitation',
    aggregateId: randomUUID(),
    failed: false,
  });
  const runId = await insertRun({ status: 'running' });
  const failedEventId = await insertEvent({
    jobName: 'advance-workflow-run',
    aggregateType: 'workflow-run',
    aggregateId: runId,
    failed: true,
  });
  return { attemptId: lease.attemptId, overdueEventId, failedEventId };
}

type Seeded = Awaited<ReturnType<typeof seedOneForEachStage>>;

async function whatEachStageLeft(seeded: Seeded) {
  return asAdmin(async (client) => {
    const attempt = await client.query<{ status: string }>(
      'select status from app.node_attempts where id = $1',
      [seeded.attemptId],
    );
    const overdue = await client.query<{ redeliveries: number }>(
      'select redeliveries from app.outbox_events where id = $1',
      [seeded.overdueEventId],
    );
    const failed = await client.query<{ watched: boolean }>(
      `select delivery_due_at is not null as watched
         from app.outbox_events where id = $1`,
      [seeded.failedEventId],
    );
    return {
      expired_leases: attempt.rows[0]?.status !== 'running',
      overdue_deliveries: overdue.rows[0]?.redeliveries === 1,
      failed_run_jobs: failed.rows[0]?.watched === false,
    };
  });
}

describe('a stage of the stalled-work scan that fails', () => {
  const signal = new AbortController().signal;
  let runtime: DatabaseRuntime;
  let store: StalledWorkStore;
  let pool: Pool;

  beforeAll(() => {
    const config = parseDatabaseConfig({
      connectionString: databaseUrl(maintenanceUrl),
      max: 4,
      ownerRole: 'pertexo_owner',
    });
    runtime = createDatabaseRuntime(config, { role: 'worker' });
    store = createStalledWorkStore(config, runtime);
    pool = acquireDatabasePool(config, runtime).pool;
  });

  // Each case starts from a database with nothing due.
  beforeEach(async () => {
    await store.recoverDue(100, signal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await store.close();
    await runtime.close();
  });

  it('settles something due at every stage when none fails', async () => {
    const seeded = await seedOneForEachStage();

    const result = await store.recoverDue(100, signal);

    expect(result.stagesFailed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.recovered.map(({ kind }) => kind).sort()).toEqual([
      'attempt_reclaimed',
      'delivery_redelivered',
      'delivery_replaced',
    ]);
    await expect(whatEachStageLeft(seeded)).resolves.toEqual({
      expired_leases: true,
      overdue_deliveries: true,
      failed_run_jobs: true,
    });
  });

  it.each(STAGES)(
    'still lets the others run when %s fails, and says which',
    async (stage) => {
      const seeded = await seedOneForEachStage();
      const failure = new Error(`${stage} is broken`);
      failStatement(pool, STAGE_STATEMENT[stage], failure);

      const result = await store.recoverDue(100, signal);

      expect(result.stagesFailed).toEqual([{ stage, error: failure }]);
      await expect(whatEachStageLeft(seeded)).resolves.toEqual({
        expired_leases: stage !== 'expired_leases',
        overdue_deliveries: stage !== 'overdue_deliveries',
        failed_run_jobs: stage !== 'failed_run_jobs',
      });

      // Nothing is lost: the stage picks its row up once it works again.
      vi.restoreAllMocks();
      const after = await store.recoverDue(100, signal);
      expect(after.stagesFailed).toEqual([]);
      expect(after.recovered).toHaveLength(1);
      await expect(whatEachStageLeft(seeded)).resolves.toEqual({
        expired_leases: true,
        overdue_deliveries: true,
        failed_run_jobs: true,
      });
    },
  );

  it('reports every stage when all of them fail', async () => {
    const failure = new Error('the database is gone');
    failStatement(
      pool,
      new RegExp(
        [
          ...STAGES.map((stage) => STAGE_STATEMENT[stage].source),
          '"job_name" =',
        ].join('|'),
        'u',
      ),
      failure,
    );

    const { stagesFailed, recovered } = await store.recoverDue(100, signal);

    expect(stagesFailed.map(({ stage }) => stage)).toEqual([
      'expired_leases',
      'overdue_deliveries',
      'failed_error_workflow_deliveries',
      'failed_run_jobs',
    ]);
    expect(recovered).toEqual([]);
  });

  // A worker's first scan also dates rows from before due times existed. It comes
  // after the rest, and a failure there mustn't lose what the rest did and found.
  it('keeps what a first scan did when dating old rows fails, and tries that again', async () => {
    const config = parseDatabaseConfig({
      connectionString: databaseUrl(maintenanceUrl),
      max: 4,
      ownerRole: 'pertexo_owner',
    });
    const firstScan = createStalledWorkStore(config, runtime);
    const seeded = await seedOneForEachStage();
    const undatedId = await insertEvent({
      jobName: 'deliver-workspace-invitation',
      aggregateType: 'workspace-invitation',
      aggregateId: randomUUID(),
      failed: false,
    });
    await asAdmin((client) =>
      client.query(
        'update app.outbox_events set delivery_due_at = null where id = $1',
        [undatedId],
      ),
    );
    const failure = new Error('dating is broken');
    failStatement(pool, /with undated as materialized/u, failure);

    const result = await firstScan.recoverDue(100, signal);

    expect(result.stagesFailed).toEqual([
      { stage: 'undated_deliveries', error: failure },
    ]);
    expect(result.recovered.map(({ kind }) => kind).sort()).toEqual([
      'attempt_reclaimed',
      'delivery_redelivered',
      'delivery_replaced',
    ]);
    await expect(whatEachStageLeft(seeded)).resolves.toEqual({
      expired_leases: true,
      overdue_deliveries: true,
      failed_run_jobs: true,
    });

    vi.restoreAllMocks();
    const after = await firstScan.recoverDue(100, signal);
    expect(after.stagesFailed).toEqual([]);
    const dated = await asAdmin((client) =>
      client.query<{ dated: boolean }>(
        'select delivery_due_at is not null as dated from app.outbox_events where id = $1',
        [undatedId],
      ),
    );
    expect(dated.rows[0]?.dated).toBe(true);
    await firstScan.close();
  });

  // Shutdown isn't a broken stage: it would log an outage nobody had.
  it('gives up on an aborted scan instead of recording it as a failed stage', async () => {
    const shutdown = new AbortController();
    interceptQueries(pool, (text, forward) => {
      if (!text.includes('from "app"."node_attempts"')) return forward();
      shutdown.abort(new Error('shutting down'));
      return Promise.reject(new Error('connection terminated'));
    });

    await expect(store.recoverDue(100, shutdown.signal)).rejects.toThrow(
      'shutting down',
    );
  });
});
