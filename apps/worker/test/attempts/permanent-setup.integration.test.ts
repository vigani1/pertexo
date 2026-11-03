import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  withOwner,
  workerQuery,
  workspaceId,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  admitProviderScenario,
  attemptJob,
  closeProofRuntime,
} from './http/fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';
import { waitFor } from '../support/attempts/http-node-attempt.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);

describeIntegration('Permanent attempt setup failures', () => {
  it.each(['checkpoint', 'missing-node'] as const)(
    'ends a %s failure before dispatch rather than cycling fresh recovered deliveries',
    async (damage) => {
      if (fixtureEncryption === undefined)
        throw new Error('Missing encryption fixture');
      let providerCalls = 0;
      const runtime = await createHttpNodeAttemptProofRuntime(
        fixtureEncryption,
        {
          sendSlackMessage: (request) => {
            providerCalls++;
            return Promise.resolve({
              kind: 'succeeded',
              channelId: request.channelId,
              messageTs: '1724412345.000100',
            });
          },
        },
      );
      try {
        const scenario = await admitProviderScenario(runtime, 'slack');
        await withOwner((client) =>
          damage === 'checkpoint'
            ? client.query(
                'update app.run_checkpoints set scheduler_state=$2 where workflow_run_id=$1',
                [scenario.accepted.runId, { corrupt: true }],
              )
            : client.query(
                "update app.node_runs set node_id='missing-node' where id=$1",
                [scenario.attempt.node_run_id],
              ),
        );
        const published = await runtime.producer.publish(
          attemptJob(scenario.accepted.runId, scenario.attempt),
        );
        const job = await waitFor(
          () => runtime.attemptQueue.getJob(published.jobId),
          (value) => value !== undefined,
        );
        if (job === undefined) throw new Error('Attempt job missing');
        await waitFor(
          () => job.getState(),
          (state) => state === 'failed' || state === 'completed',
        );
        expect(
          await workerQuery(
            'select status,error_summary,completed_at from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([
          {
            status: 'failed',
            error_summary: 'execution.run_state_invalid',
            completed_at: expect.any(Date) as unknown,
          },
        ]);
        expect(
          await workerQuery(
            'select status,dispatch_marked_at from app.node_attempts where id=$1',
            [scenario.attempt.attempt_id],
          ),
        ).toEqual([{ status: 'canceled', dispatch_marked_at: null }]);
        expect(
          await workerQuery(
            'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
            [workspaceId],
          ),
        ).toEqual([{ active_runs: 0 }]);
        expect(
          await workerQuery(
            'select completed_at is not null as completed from app.inbox_receipts where workspace_id=$1 and message_id=$2',
            [workspaceId, scenario.attempt.outbox_id],
          ),
        ).toEqual([{ completed: true }]);
        expect(providerCalls).toBe(0);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
});
