import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  withOwner,
  workerQuery,
  waitFor,
  slackConnectionId,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  admitProviderScenario,
  publishAndWaitForCompletion,
  attemptJob,
  advanceScenario,
  closeProofRuntime,
} from './http/fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('Deadline during prerequisite dispatch locks', () => {
  it('refuses provider I/O when the deadline expires during the real credential share-lock wait', async () => {
    if (fixtureEncryption === undefined) throw new Error('Missing fixture');
    let armed = false,
      providerCalls = 0;
    let release: (() => void) | undefined;
    let holder: Promise<unknown> | undefined,
      releaseTask: Promise<void> | undefined;
    const runtime = await createHttpNodeAttemptProofRuntime(fixtureEncryption, {
      heartbeatIntervalMillis: 60_000,
      beforeMarkDispatched: async ({ lease }) => {
        if (!armed || lease.nodeId !== 'provider') return;
        await withOwner((client) =>
          client.query(
            "update app.workflow_runs set deadline_at=clock_timestamp()+interval '2 seconds' where id=$1",
            [lease.runId],
          ),
        );
        let entered!: () => void;
        const acquired = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let blocker = 0;
        holder = withOwner(async (client) => {
          const result = await client.query<{ pid: number }>(
            'select pg_backend_pid() pid',
          );
          blocker = result.rows[0]?.pid ?? 0;
          await client.query(
            'select id from app.connections where id=$1 for update',
            [slackConnectionId],
          );
          entered();
          await held;
        });
        await acquired;
        releaseTask = (async () => {
          try {
            const waiting = await waitFor(
              () =>
                workerQuery<{ blocked: boolean; before_deadline: boolean }>(
                  `select exists(select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))) blocked,clock_timestamp()<deadline_at as before_deadline from app.workflow_runs where id=$2`,
                  [blocker, lease.runId],
                ),
              (rows) => rows[0]?.blocked === true,
            );
            expect(waiting[0]?.before_deadline).toBe(true);
            await waitFor(
              () =>
                workerQuery<{ expired: boolean }>(
                  'select clock_timestamp()>deadline_at as expired from app.workflow_runs where id=$1',
                  [lease.runId],
                ),
              (rows) => rows[0]?.expired === true,
            );
          } finally {
            release?.();
          }
        })();
        void releaseTask.catch(() => undefined);
      },
      sendSlackMessage: (request) => {
        providerCalls++;
        return Promise.resolve({
          kind: 'succeeded',
          channelId: request.channelId,
          messageTs: '1724412345.000100',
        });
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'slack');
      armed = true;
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Deadline during credential wait',
      );
      await releaseTask;
      expect(providerCalls).toBe(0);
      expect(
        await workerQuery(
          'select status,dispatch_marked_at from app.node_attempts where id=$1',
          [scenario.attempt.attempt_id],
        ),
      ).toEqual([{ status: 'timed_out', dispatch_marked_at: null }]);
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Settle lock-wait deadline',
      );
      expect(
        await workerQuery('select status from app.workflow_runs where id=$1', [
          scenario.accepted.runId,
        ]),
      ).toEqual([{ status: 'timed_out' }]);
    } finally {
      release?.();
      await Promise.allSettled([holder, releaseTask]);
      await closeProofRuntime(runtime);
    }
  }, 30_000);
});
