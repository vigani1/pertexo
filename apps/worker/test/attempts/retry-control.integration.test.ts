import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  workerQuery,
  cancelProviderScenarioRun,
  expireProviderScenarioRun,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  prepareAmbiguousEmailRetry,
  publishAndWaitForCompletion,
  attemptJob,
  advanceScenario,
  closeProofRuntime,
} from './http/http.fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('Prior provider uncertainty at retry dispatch', () => {
  it.each(['canceled', 'timed_out'] as const)(
    'preserves the possible first effect when %s stops the keyed retry',
    async (reason) => {
      if (fixtureEncryption === undefined) throw new Error('Missing fixture');
      let armed = false,
        providerCalls = 0;
      const runtime = await createHttpNodeAttemptProofRuntime(
        fixtureEncryption,
        {
          heartbeatIntervalMillis: 60_000,
          beforeMarkDispatched: async ({ lease }) => {
            if (!armed || lease.nodeId !== 'provider') return;
            if (reason === 'canceled')
              await cancelProviderScenarioRun(lease.runId);
            else await expireProviderScenarioRun(lease.runId);
          },
          sendEmailNotification: async (request) => {
            await request.beforeDispatch();
            providerCalls++;
            throw new Error('Provider reset after possible dispatch');
          },
        },
      );
      try {
        const scenario = await prepareAmbiguousEmailRetry(runtime);
        armed = true;
        await publishAndWaitForCompletion(
          runtime.producer,
          runtime.attemptQueue,
          attemptJob(scenario.accepted.runId, scenario.retry),
          'Stop ambiguous retry',
        );
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          'Settle prior uncertainty',
        );
        expect(
          await workerQuery(
            'select attempt_number,status,executor_possibly_dispatched,retry_decision,dispatch_marked_at is not null as dispatched from app.node_attempts where node_run_id=$1 order by attempt_number',
            [scenario.attempt.node_run_id],
          ),
        ).toEqual([
          {
            attempt_number: 1,
            status: 'failed',
            executor_possibly_dispatched: true,
            retry_decision: 'retry',
            dispatched: true,
          },
          {
            attempt_number: 2,
            status: 'outcome_unknown',
            executor_possibly_dispatched: null,
            retry_decision: null,
            dispatched: false,
          },
        ]);
        expect(
          await workerQuery(
            'select status from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([{ status: 'outcome_unknown' }]);
        expect(providerCalls).toBe(1);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
});
