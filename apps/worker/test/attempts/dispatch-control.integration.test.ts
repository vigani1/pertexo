import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  cancelProviderScenarioRun,
  expireProviderScenarioRun,
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
  advanceScenario,
  closeProofRuntime,
  publishAndWaitForCompletion,
} from './http/fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);

describeIntegration('Durable control at dispatch', () => {
  it.each(['canceled', 'timed_out'] as const)(
    'refuses provider I/O after %s commits before dispatch',
    async (reason) => {
      if (fixtureEncryption === undefined)
        throw new Error('Missing encryption fixture');
      let providerCalls = 0;
      let armed = false;
      const runtime = await createHttpNodeAttemptProofRuntime(
        fixtureEncryption,
        {
          heartbeatIntervalMillis: 60_000,
          beforeMarkDispatched: async ({ lease }) => {
            if (!armed) return;
            if (reason === 'canceled')
              await cancelProviderScenarioRun(lease.runId);
            else await expireProviderScenarioRun(lease.runId);
          },
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
        armed = true;
        await publishAndWaitForCompletion(
          runtime.producer,
          runtime.attemptQueue,
          attemptJob(scenario.accepted.runId, scenario.attempt),
          'Dispatch fence control',
        );
        expect(providerCalls).toBe(0);
        expect(
          await workerQuery(
            'select status,dispatch_marked_at from app.node_attempts where id=$1',
            [scenario.attempt.attempt_id],
          ),
        ).toEqual([{ status: reason, dispatch_marked_at: null }]);
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          'Settle dispatch control',
        );
        expect(
          await workerQuery(
            'select status from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([{ status: reason }]);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
});
