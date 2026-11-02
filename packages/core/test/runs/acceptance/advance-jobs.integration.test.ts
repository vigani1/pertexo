import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cancelInTransaction } from '../../../src/runs/commands/cancel-run.js';
import { enqueueAdvance } from '../../../src/runs/wakeups/advance.queries.js';
import {
  createTestRunStore,
  type TestRunStore,
} from '../../support/run-advance-store.js';
import {
  acceptRun,
  setLimit,
  withOwner,
} from '../../authoring/settings/concurrency-admission.fixtures.js';
import {
  apiDatabase,
  apiUrl,
  installExecutionAcceptanceFixture,
  workspaceA,
  workspaceCreatorId,
} from './fixtures.js';

installExecutionAcceptanceFixture();

const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const signal = new AbortController().signal;

type JobRow = Readonly<{
  id: string;
  payload: Readonly<Record<string, unknown>>;
  payload_checksum: string;
  aggregate_id: string;
  job_name: string;
  aggregate_type: string;
  delay_seconds: number;
}>;

const JOB_COLUMNS = `id,payload,payload_checksum,aggregate_id,job_name,aggregate_type,
  extract(epoch from available_at-clock_timestamp())::float8 delay_seconds`;

const jobs = async (runId: string): Promise<readonly JobRow[]> => {
  const { rows } = await withOwner((client) =>
    client.query<JobRow>(
      `select ${JOB_COLUMNS} from app.outbox_events
        where aggregate_id=$1 order by created_at`,
      [runId],
    ),
  );
  return rows;
};

const job = async (id: string): Promise<JobRow> => {
  const { rows } = await withOwner((client) =>
    client.query<JobRow>(
      `select ${JOB_COLUMNS} from app.outbox_events where id=$1`,
      [id],
    ),
  );
  const [row] = rows;
  if (row === undefined) throw new Error('Expected the job');
  return row;
};

describe('the job that advances a run', () => {
  let store: TestRunStore;

  beforeAll(() => {
    store = createTestRunStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
    );
  });

  afterAll(() => store.close());

  const deliver = (runId: string, row: JobRow, checksum?: string) =>
    store.acknowledgeAdvanceDelivery({
      workspaceId: workspaceA,
      runId,
      signal,
      delivery: {
        outboxEventId: row.id,
        payloadChecksum: checksum ?? row.payload_checksum,
      },
    });

  /** What a worker checks when the job reaches it. */
  const expectDelivers = async (runId: string, row: JobRow) => {
    expect(row.payload_checksum).toBe(
      canonicalOutboxPayloadChecksum(row.payload),
    );
    await expect(deliver(runId, row, 'f'.repeat(64))).rejects.toThrow();
    // This fixture's version has nothing to run, so the advance ends just past the
    // check on the delivery, which is what's being read here.
    await expect(deliver(runId, row)).resolves.toMatchObject({
      kind: 'not_found',
    });
  };

  const addJob = (input: Readonly<Record<string, unknown>>, runId: string) =>
    apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      enqueueAdvance(db, { workspaceId: workspaceA, runId, ...input }),
    );

  const acceptedRun = async () => {
    await setLimit(null);
    return (await acceptRun()).runId;
  };

  it('is due at once with no delay, and later with one, by the database’s clock', async () => {
    const runId = await acceptedRun();

    const now = await job(await addJob({}, runId));
    const later = await job(await addJob({ delaySeconds: 600 }, runId));
    const soon = await job(await addJob({ delaySeconds: 0 }, runId));

    expect(now.delay_seconds).toBeLessThanOrEqual(0);
    expect(soon.delay_seconds).toBeLessThanOrEqual(0);
    expect(later.delay_seconds).toBeGreaterThan(590);
    expect(later.delay_seconds).toBeLessThanOrEqual(600);
  });

  it('takes the id a caller recorded first, and the payload names it', async () => {
    const runId = await acceptedRun();
    const given = randomUUID();

    await expect(addJob({ outboxEventId: given }, runId)).resolves.toBe(given);

    const row = await job(given);
    expect(row.payload).toEqual({
      workspaceId: workspaceA,
      runId,
      outboxEventId: given,
    });
    expect(row).toMatchObject({
      job_name: 'advance-workflow-run',
      aggregate_type: 'workflow-run',
      aggregate_id: runId,
    });
    await expectDelivers(runId, row);
  });

  it('carries a traceparent only when there is one', async () => {
    const runId = await acceptedRun();

    const traced = await job(await addJob({ traceparent: TRACE }, runId));
    const untraced = await job(await addJob({}, runId));

    expect(traced.payload.traceparent).toBe(TRACE);
    expect(untraced.payload).not.toHaveProperty('traceparent');
    await expectDelivers(runId, traced);
    await expectDelivers(runId, untraced);
  });

  it('from accepting a run reaches the worker intact', async () => {
    const runId = await acceptedRun();

    const [accepted] = await jobs(runId);

    if (accepted === undefined) throw new Error('Expected the job');
    expect(accepted.payload).toEqual({
      workspaceId: workspaceA,
      runId,
      outboxEventId: accepted.id,
    });
    await expectDelivers(runId, accepted);
  });

  it('from cancelling a run reaches the worker intact, trace and all', async () => {
    const runId = await acceptedRun();
    const before = new Set((await jobs(runId)).map(({ id }) => id));

    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      cancelInTransaction(transaction, {
        workspaceId: workspaceA,
        actorId: workspaceCreatorId,
        runId,
        traceparent: TRACE,
      }),
    );

    const added = (await jobs(runId)).filter(({ id }) => !before.has(id));
    expect(added).toHaveLength(1);
    const [cancelled] = added;
    if (cancelled === undefined) throw new Error('Expected the job');
    expect(cancelled.payload).toEqual({
      workspaceId: workspaceA,
      runId,
      outboxEventId: cancelled.id,
      traceparent: TRACE,
    });
    await expectDelivers(runId, cancelled);
  });

  it('isn’t sent twice when a run is cancelled twice', async () => {
    const runId = await acceptedRun();
    const cancel = () =>
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        cancelInTransaction(transaction, {
          workspaceId: workspaceA,
          actorId: workspaceCreatorId,
          runId,
        }),
      );
    await cancel();
    const after = (await jobs(runId)).length;

    await expect(cancel()).resolves.toMatchObject({ alreadyRequested: true });

    expect(await jobs(runId)).toHaveLength(after);
  });
});
