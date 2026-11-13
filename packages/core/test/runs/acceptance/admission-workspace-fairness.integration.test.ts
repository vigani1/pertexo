import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimOutboxBatch } from '../../../src/outbox/dispatcher/claim.js';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance/accept.js';
import { useInstanceCapacity } from '../../support/instance-capacity.js';
import {
  acceptanceInput,
  apiDatabase,
  apiUrl,
  dispatcherDatabase,
  installExecutionAcceptanceFixture,
  migrationUrl,
  workerDatabase,
  workspaceA,
  workspaceB,
} from './run-acceptance.fixture.js';

const WORKSPACE_LIMIT = 3;
const NOISY_BACKLOG = 200;
const QUIET_RUNS = 10;
const RUN_LENGTH_MS = 40;
// With the noisy workspace full, held quiet runs would wait for its whole
// backlog: 200 runs × 40 ms ÷ 3 slots is over 2.6 s before any overhead. A quiet
// run that is admitted on its merits waits one claim cycle, a few milliseconds;
// 1 s leaves room for a loaded machine and stays well under that.
const MAX_QUIET_WAIT_MS = 1_000;

installExecutionAcceptanceFixture();
describe('a quiet workspace beside a noisy one', () => {
  useInstanceCapacity(
    {
      activeRunLimit: WORKSPACE_LIMIT,
      queuedRunLimit: 1_000,
      artifactCountLimit: 1_000,
    },
    apiUrl,
  );

  let dispatchers: Pool;
  beforeAll(() => {
    const url = new URL(
      process.env.DATABASE_MAINTENANCE_URL ??
        'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
    );
    url.pathname = new URL(migrationUrl).pathname;
    dispatchers = new Pool({ connectionString: url.toString(), max: 3 });
  });
  afterAll(() => dispatchers.end());

  it('admits quiet runs in the first claim while the noisy workspace is full', async () => {
    await acceptRuns(workspaceA, NOISY_BACKLOG);
    // The noisy workspace takes its slots; the rest of its backlog is held.
    expect(
      (await claim(25)).filter(({ workspaceId }) => workspaceId === workspaceA),
    ).toHaveLength(WORKSPACE_LIMIT);

    const quiet = await acceptRuns(workspaceB, 2);
    const granted = await claim(4);
    expect(granted.map(({ runId }) => runId).sort()).toEqual([...quiet].sort());
  }, 120_000);

  it('keeps each quiet run’s wait short while the noisy backlog drains', async () => {
    await acceptRuns(workspaceA, NOISY_BACKLOG);
    const acceptedAt = new Map<string, number>();
    const waits = new Map<string, number>();
    const finishing: Promise<void>[] = [];
    const stop = new AbortController();

    const dispatch = async () => {
      while (!stop.signal.aborted) {
        const granted = await claim(4);
        const now = Date.now();
        for (const { runId, workspaceId } of granted) {
          const accepted = acceptedAt.get(runId);
          if (accepted !== undefined) waits.set(runId, now - accepted);
          finishing.push(runBriefly(workspaceId, runId));
        }
        if (granted.length === 0) await sleep(5);
      }
    };
    const produce = async () => {
      for (let index = 0; index < QUIET_RUNS; index += 1) {
        await sleep(150);
        const [runId] = await acceptRuns(
          workspaceB,
          1,
          `live-${String(index)}`,
        );
        if (runId === undefined) throw new Error('Expected a quiet run');
        acceptedAt.set(runId, Date.now());
      }
      const deadline = Date.now() + 10_000;
      while (waits.size < QUIET_RUNS && Date.now() < deadline) await sleep(10);
      stop.abort();
    };
    await Promise.all([dispatch(), dispatch(), dispatch(), produce()]);
    await Promise.all(finishing);

    expect(waits.size).toBe(QUIET_RUNS);
    expect(Math.max(...waits.values())).toBeLessThan(MAX_QUIET_WAIT_MS);
    // The noisy workspace was still busy for the whole quiet load.
    expect(await queuedRuns(workspaceA)).toBeGreaterThan(0);
  }, 120_000);

  async function claim(limit: number) {
    const batch = await claimOutboxBatch(dispatchers, {
      enabledJobNames: ['advance-workflow-run'],
      leaseDurationMillis: 30_000,
      leaseOwner: 'workspace-fairness',
      leaseToken: randomUUID(),
      limit,
    });
    for (const event of batch.events)
      if (!(await dispatcherDatabase.markPublished(event.id, event.leaseToken)))
        throw new Error('Could not publish a claimed delivery');
    return batch.events.map(({ aggregateId, workspaceId }) => ({
      runId: aggregateId,
      workspaceId,
    }));
  }
});

async function acceptRuns(
  workspaceId: string,
  count: number,
  label = 'backlog',
): Promise<string[]> {
  const runIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const hash = (value: string) =>
      createHash('sha256')
        .update(`${workspaceId}-${label}-${value}-${String(index)}`)
        .digest('hex');
    const accepted = await apiDatabase.withWorkspace(
      workspaceId,
      (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(hash('request')),
          keyHash: hash('key'),
          scope: `fairness:${label}:${String(index)}`,
        }),
    );
    runIds.push(accepted.runId);
  }
  return runIds;
}

async function runBriefly(workspaceId: string, runId: string) {
  await transition(workspaceId, runId, 'running');
  await sleep(RUN_LENGTH_MS);
  await transition(workspaceId, runId, 'succeeded');
}

async function transition(
  workspaceId: string,
  runId: string,
  status: 'running' | 'succeeded',
) {
  await workerDatabase.withWorkspace(workspaceId, async ({ db }) => {
    await db.execute(
      sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
    );
    await db.execute(sql`
      update app.workflow_runs set status=${status}
       where workspace_id=${workspaceId} and id=${runId}
    `);
  });
}

async function queuedRuns(workspaceId: string): Promise<number> {
  return apiDatabase.withWorkspace(workspaceId, async ({ db }) => {
    const result = await db.execute<{ queued: number }>(sql`
      select count(*)::integer queued from app.workflow_runs
       where workspace_id=${workspaceId} and status='queued'
    `);
    return result.rows[0]?.queued ?? 0;
  });
}
