import { randomUUID } from 'node:crypto';

import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import type { OutboxDispatcherDatabase } from '@pertexo/core/testing';
import {
  canonicalOutboxPayloadChecksum,
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { JOB_NAME, type QueueJob, type QueueProducer } from '@pertexo/queue';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { OutboxDispatcher } from '../../src/transport/outbox/dispatch/runtime.js';
import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required`);
  return value;
};

/** Long past any wait here: a row delivered at all was delivered by its signal. */
const IDLE_POLL_MILLIS = 600_000;
const LIMIT_MS = 60_000;
const WAIT = { timeout: 30_000, interval: 25 };

describe('a dispatcher woken by rows, on real PostgreSQL', () => {
  const adminUrl = required('DATABASE_ADMIN_URL');
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
    databaseName: `pertexo_test_row_signal_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const workspaceId = randomUUID();
  let admin: Client;
  const stoppers: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    await fixture.create();
    await migrateDatabase(
      parseMigrationConfig({
        DATABASE_MIGRATION_URL: fixture.databaseUrl(
          required('DATABASE_MIGRATION_URL'),
        ),
      }),
    );
    admin = new Client({ connectionString: fixture.databaseUrl(adminUrl) });
    await admin.connect();
    const userId = randomUUID();
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Row signal')`,
      [userId, `${userId}@example.test`],
    );
    await admin.query(
      `insert into app.workspaces(id,name,slug,created_by) values($1,'Row signal',$2,$3)`,
      [workspaceId, `row-signal-${workspaceId}`, userId],
    );
    await admin.query('commit');
  }, LIMIT_MS);

  afterAll(async () => {
    await admin.end();
    await fixture.drop();
  });

  afterEach(async () => {
    for (const stop of stoppers.splice(0)) await stop();
    await admin.query('delete from app.outbox_events');
  });

  /** The queue is the outside service here; everything up to it is real. */
  const recordingProducer = () => {
    const published: string[] = [];
    const producer: QueueProducer = {
      publish: (job: QueueJob) => {
        published.push(job.data.outboxEventId);
        return Promise.resolve({
          jobId: `outbox-${job.data.outboxEventId}`,
          jobName: JOB_NAME.deliverWorkspaceInvitation,
          outcome: 'published',
          queueName: 'maintenance',
        });
      },
      observe: () => Promise.resolve([]),
      isReady: () => true,
      waitUntilReady: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    return { producer, published };
  };

  const startDispatcher = (
    wrap: (database: OutboxDispatcherDatabase) => OutboxDispatcherDatabase = (
      database,
    ) => database,
  ) => {
    // A pool of one: the watch must not take the only connection from the claims.
    const database = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(
          required('DATABASE_MAINTENANCE_URL'),
        ),
        max: 1,
        ownerRole: 'pertexo_owner',
      }),
    );
    const { producer, published } = recordingProducer();
    const dispatcher = new OutboxDispatcher(wrap(database), producer, {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.deliverWorkspaceInvitation],
        leaseDurationMillis: 30_000,
        leaseOwner: 'row-signal',
        operationTimeoutMillis: 30_000,
        pollIntervalMillis: IDLE_POLL_MILLIS,
        retryDelayMillis: 1_000,
      },
    });
    dispatcher.start();
    stoppers.push(() => dispatcher.close());
    return { published };
  };

  const insertRow = async (
    jobName: string = JOB_NAME.deliverWorkspaceInvitation,
  ): Promise<string> => {
    const id = randomUUID();
    const payload = {
      workspaceId,
      invitationId: randomUUID(),
      deliveryAttemptId: randomUUID(),
      outboxEventId: id,
    };
    await admin.query(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum
       ) values ($1,$2,$3,'workspace-invitation',$4,$5::jsonb,$6)`,
      [
        id,
        workspaceId,
        jobName,
        payload.invitationId,
        JSON.stringify(payload),
        canonicalOutboxPayloadChecksum(payload),
      ],
    );
    return id;
  };

  const listeners = async (): Promise<readonly number[]> => {
    const { rows } = await admin.query<{ pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and query ilike 'listen outbox_rows%'`,
    );
    return rows.map(({ pid }) => pid);
  };

  const listening = async (): Promise<readonly number[]> => {
    await vi.waitFor(async () => {
      expect(await listeners()).toHaveLength(1);
    }, WAIT);
    return listeners();
  };

  it(
    'delivers a new row from an idle wait, on a pool of one',
    async () => {
      const { published } = startDispatcher();
      await listening();

      const first = await insertRow();
      await vi.waitFor(() => {
        expect(published).toEqual([first]);
      }, WAIT);

      const second = await insertRow();
      await vi.waitFor(() => {
        expect(published).toEqual([first, second]);
      }, WAIT);
    },
    LIMIT_MS,
  );

  it(
    'finds a row written before it started listening',
    async () => {
      const before = await insertRow();

      const { published } = startDispatcher();

      await vi.waitFor(() => {
        expect(published).toEqual([before]);
      }, WAIT);
    },
    LIMIT_MS,
  );

  // A claim that has already read the table misses this row, and it found nothing
  // to send, so the dispatcher goes back to its idle wait. Only the signal it heard
  // during the claim can stop that.
  it(
    'skips the next wait for a signal that arrives during a claim',
    async () => {
      const claimRead = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let holding = false;
      let signals = 0;
      const { published } = startDispatcher((database) => ({
        ...database,
        watchForRows: (onRows, signal) =>
          database.watchForRows(() => {
            signals += 1;
            onRows();
          }, signal),
        claimBatch: async (input) => {
          const result = await database.claimBatch(input);
          if (holding) {
            holding = false;
            claimRead.resolve(undefined);
            await release.promise;
          }
          return result;
        },
      }));
      await listening();

      // A row it isn't enabled to claim, for a claim that finds nothing.
      holding = true;
      await insertRow(JOB_NAME.advanceWorkflowRun);
      await claimRead.promise;
      const signalsBefore = signals;
      const signalledMidClaim = await insertRow();
      await vi.waitFor(() => {
        expect(signals).toBeGreaterThan(signalsBefore);
      }, WAIT);
      release.resolve(undefined);

      await vi.waitFor(() => {
        expect(published).toEqual([signalledMidClaim]);
      }, WAIT);
    },
    LIMIT_MS,
  );

  it(
    'listens again after losing its connection, and finds what it missed',
    async () => {
      const { published } = startDispatcher();
      const [lost] = await listening();
      if (lost === undefined) throw new Error('Expected a listener');

      await admin.query('select pg_terminate_backend($1)', [lost]);
      const missed = await insertRow();

      await vi.waitFor(() => {
        expect(published).toEqual([missed]);
      }, WAIT);
      expect(await listeners()).not.toContain(lost);

      const after = await insertRow();
      await vi.waitFor(() => {
        expect(published).toEqual([missed, after]);
      }, WAIT);
    },
    LIMIT_MS,
  );

  it(
    'stops listening when it closes',
    async () => {
      startDispatcher();
      await listening();

      for (const stop of stoppers.splice(0)) await stop();

      await vi.waitFor(async () => {
        expect(await listeners()).toEqual([]);
      }, WAIT);
    },
    LIMIT_MS,
  );
});
