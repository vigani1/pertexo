import {
  acquireDatabasePool,
  createDatabaseRuntime,
} from '@pertexo/database/platform';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { failUnadvanceableRun } from '../../../../src/runs/advance/fail-unadvanceable.repository.js';
import {
  asAdmin,
  databaseUrl,
  insertRun,
  ownedDeliveryStore,
  parseDatabaseConfig,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';
import { signal } from './support.js';

const HOUR = 3_600_000;

describe('the clock on a run’s history', () => {
  const databaseNow = async (): Promise<number> => {
    const { rows } = await asAdmin((client) =>
      client.query<{ now: Date }>('select clock_timestamp() "now"'),
    );
    return (rows[0]?.now ?? new Date(0)).getTime();
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  const skewClockAnHour = async (): Promise<number> => {
    const truth = await databaseNow();
    vi.useFakeTimers({ toFake: ['Date'], now: truth + HOUR });
    return truth;
  };

  it('tells the decision the database’s time, not this process’s', async () => {
    const runId = await insertRun({});
    const truth = await skewClockAnHour();

    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
    });

    if (loaded.kind !== 'ready') throw new Error('Expected the run to load');
    const seen = new Date(loaded.state.occurredAt).getTime();
    expect(Math.abs(seen - truth)).toBeLessThan(60_000);
  });

  describe('when a run can’t be advanced', () => {
    let runtime: ReturnType<typeof createDatabaseRuntime>;
    let pool: ReturnType<typeof acquireDatabasePool>['pool'];

    beforeAll(() => {
      const config = parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
        ownerRole: 'pertexo_owner',
      });
      runtime = createDatabaseRuntime(config, { role: 'worker' });
      pool = acquireDatabasePool(config, runtime).pool;
    });

    afterAll(() => runtime.close());

    it('ends it by the database’s time too', async () => {
      const runId = await insertRun({ status: 'running' });
      const truth = await skewClockAnHour();

      await expect(
        failUnadvanceableRun(pool, {
          workspaceId: workspaceA,
          runId,
          safeErrorCode: 'run.unadvanceable',
          expectedRevision: 0,
          signal,
        }),
      ).resolves.toBe('failed');

      const { rows } = await asAdmin((client) =>
        client.query<{ completed_at: Date; event_at: Date; status: string }>(
          `select r.completed_at,r.status,
                  (select e.created_at from app.run_events e
                    where e.workflow_run_id=r.id and e.type='run.failed') event_at
             from app.workflow_runs r where r.id=$1`,
          [runId],
        ),
      );
      const [row] = rows;
      expect(row?.status).toBe('failed');
      expect(Math.abs((row?.completed_at.getTime() ?? 0) - truth)).toBeLessThan(
        60_000,
      );
      expect(Math.abs((row?.event_at.getTime() ?? 0) - truth)).toBeLessThan(
        60_000,
      );
    });
  });
});
