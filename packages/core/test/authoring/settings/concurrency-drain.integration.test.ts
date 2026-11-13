import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { claimOutboxBatch } from '../../../src/outbox/dispatcher/claim.js';
import type { LeasedOutboxEvent } from '../../../src/outbox/dispatcher/outbox-dispatcher.types.js';
import {
  apiUrl,
  dispatcherDatabase,
  installExecutionAcceptanceFixture,
  migrationUrl,
  workflowId,
  workspaceA,
  workspaceCreatorId,
} from '../../runs/acceptance/run-acceptance.fixture.js';
import { useInstanceCapacity } from '../../support/instance-capacity.js';
import { createTestRunStore } from '../../support/run-advance-store.js';
import {
  acceptRun,
  setLimit,
  transitionRun,
  withOwner,
} from './concurrency-admission.fixtures.js';
import {
  publishExecutableVersion,
  startInput,
  workerUrl,
} from './concurrency-review-regressions.fixture.js';

const WORKSPACE_LIMIT = 3;
const WORKFLOW_LIMIT = 2;
const RUNS_PER_WORKFLOW = 24;
const DISPATCHERS = 3;
const RUN_LENGTH_MS = 30;
// The ordered-start fallback defers a run 5 s. A next start that waited on it
// leaves a gap of nearly 5 s; 2 s leaves room for a loaded machine.
const MAX_START_GAP_MS = 2_000;
// The whole drain takes about 2 s; a stall behind the 5 s fallback many times
// over doesn't fit.
const DRAIN_LIMIT_MS = 30_000;

installExecutionAcceptanceFixture();
describe('draining a limited backlog with concurrent dispatchers', () => {
  useInstanceCapacity(
    {
      activeRunLimit: WORKSPACE_LIMIT,
      queuedRunLimit: 1_000,
      artifactCountLimit: 1_000,
    },
    apiUrl,
  );

  let dispatchers: Pool;
  let observer: Pool;
  beforeAll(() => {
    dispatchers = new Pool({
      connectionString: withFixtureDatabase(
        process.env.DATABASE_MAINTENANCE_URL ??
          'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
      ),
      max: DISPATCHERS,
    });
    observer = new Pool({
      connectionString: withFixtureDatabase(
        process.env.DATABASE_ADMIN_URL ??
          'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
      ),
      max: 1,
    });
  });
  afterAll(async () => {
    await dispatchers.end();
    await observer.end();
  });

  it('never exceeds either limit, starts the limited runs in order and leaves no slot idle', async () => {
    const unlimitedWorkflowId = randomUUID();
    const unlimitedVersionId = randomUUID();
    await setLimit(WORKFLOW_LIMIT);
    await publishExecutableVersion();
    await setLimit(null, unlimitedWorkflowId);
    await publishVersion(unlimitedWorkflowId, unlimitedVersionId);

    // Interleaved submissions, so both queues hold a backlog from the start.
    const runs = new Map<string, Awaited<ReturnType<typeof acceptRun>>>();
    const limitedRuns: string[] = [];
    for (let index = 0; index < RUNS_PER_WORKFLOW; index += 1) {
      const limited = await acceptRun();
      limitedRuns.push(limited.runId);
      runs.set(limited.runId, limited);
      const unlimited = await acceptRun({
        workflowId: unlimitedWorkflowId,
        workflowVersionId: unlimitedVersionId,
      });
      runs.set(unlimited.runId, unlimited);
    }

    const store = createTestRunStore(
      parseDatabaseConfig({ connectionString: workerUrl(), max: DISPATCHERS }),
    );
    const peaks = { workspace: 0, limited: 0 };
    const starts: { id: string; at: number }[] = [];
    const finishing: Promise<void>[] = [];
    let finished = 0;
    const sampling = new AbortController();
    const sampler = (async () => {
      while (!sampling.signal.aborted) {
        const occupancy = await readOccupancy();
        peaks.workspace = Math.max(peaks.workspace, occupancy.workspace);
        peaks.limited = Math.max(peaks.limited, occupancy.limited);
        await sleep(2);
      }
    })();

    // One worker per dispatcher: claim, publish, then start what it was given
    // all at once, as a worker's concurrent jobs would.
    const start = async (event: LeasedOutboxEvent) => {
      const run = runs.get(event.aggregateId);
      if (run === undefined) throw new Error('Claimed an unknown run');
      // Every other limited run starts slowly, so the run behind it often
      // starts first and is deferred until the slow one starts.
      const position = limitedRuns.indexOf(event.aggregateId);
      await sleep(position >= 0 && position % 2 === 0 ? 40 : 0);
      const version = run.request.workflowVersionId;
      const result = await store.commitAdvancePlan({
        ...startInput(event, run.request.initialCheckpoint),
        workflowVersionId: version,
      });
      if (result.kind !== 'committed') return;
      // A start commits only once the run ahead of it has, so the order starts
      // complete in is the order they took effect.
      if (limitedRuns.includes(event.aggregateId))
        starts.push({ id: event.aggregateId, at: Date.now() });
      finishing.push(
        (async () => {
          await sleep(RUN_LENGTH_MS);
          await transitionRun(event.aggregateId, 'succeeded');
          finished += 1;
        })(),
      );
    };
    const deadline = Date.now() + DRAIN_LIMIT_MS;
    const dispatch = async (name: string) => {
      while (finished < runs.size && Date.now() < deadline) {
        const batch = await claimOutboxBatch(dispatchers, {
          enabledJobNames: ['advance-workflow-run'],
          leaseDurationMillis: 30_000,
          leaseOwner: name,
          leaseToken: randomUUID(),
          limit: 2,
        });
        for (const event of batch.events)
          if (
            !(await dispatcherDatabase.markPublished(
              event.id,
              event.leaseToken,
            ))
          )
            throw new Error('Could not publish a claimed delivery');
        await Promise.all(batch.events.map(start));
        if (batch.events.length === 0) await sleep(5);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: DISPATCHERS }, (_, index) =>
          dispatch(`drain-${String(index)}`),
        ),
      );
      await Promise.all(finishing);
    } finally {
      sampling.abort();
      await sampler;
      await store.close();
    }

    expect(peaks.workspace).toBeLessThanOrEqual(WORKSPACE_LIMIT);
    expect(peaks.limited).toBeLessThanOrEqual(WORKFLOW_LIMIT);
    // The limits were reached, so the bounds above were really under test.
    expect(peaks.workspace).toBe(WORKSPACE_LIMIT);
    const gaps = starts
      .slice(1)
      .map(({ at }, index) => at - (starts[index]?.at ?? at));
    expect(Math.max(...gaps)).toBeLessThan(MAX_START_GAP_MS);
    expect(finished, 'runs finished within the drain limit').toBe(runs.size);
    expect(starts.map(({ id }) => id)).toEqual(limitedRuns);
  }, 120_000);

  async function readOccupancy() {
    // A run holds a slot from its grant until it settles.
    const result = await observer.query<{ workspace: number; limited: number }>(
      `select count(*)::integer workspace,
              count(*) filter (where run.workflow_id=$2)::integer limited
         from app.workflow_runs run
        where run.workspace_id=$1
          and (run.status in ('running','waiting')
               or (run.status='queued' and exists (
                     select 1 from app.workflow_run_active_admissions admission
                      where admission.workflow_run_id=run.id)))`,
      [workspaceA, workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Expected an occupancy row');
    return row;
  }
});

function withFixtureDatabase(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = new URL(migrationUrl).pathname;
  return url.toString();
}

async function publishVersion(id: string, versionId: string): Promise<void> {
  await withOwner(async (client) => {
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,published_by
       ) values ($1,$2,$3,1,'{}'::jsonb,$4,$5::json,$6)`,
      [
        versionId,
        workspaceA,
        id,
        `wf:sha256:${'d'.repeat(64)}`,
        JSON.stringify({ graph: { nodes: [], edges: [] } }),
        workspaceCreatorId,
      ],
    );
  });
}
