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

describeIntegration('Provider-confirmed success after run control', () => {
  it.each(['canceled', 'timed_out'] as const)(
    'keeps a confirmed effect and output when %s arrives during the call',
    async (reason) => {
      if (fixtureEncryption === undefined)
        throw new Error('Missing encryption fixture');
      let providerCalls = 0;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const runtime = await createHttpNodeAttemptProofRuntime(
        fixtureEncryption,
        {
          heartbeatIntervalMillis: 20,
          sendSlackMessage: async (request) => {
            providerCalls++;
            entered();
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else
                request.signal.addEventListener(
                  'abort',
                  () => {
                    resolve();
                  },
                  {
                    once: true,
                  },
                );
            });
            return {
              kind: 'succeeded',
              channelId: request.channelId,
              messageTs: '1724412345.000100',
            };
          },
        },
      );
      try {
        const scenario = await admitProviderScenario(runtime, 'slack');
        const completion = publishAndWaitForCompletion(
          runtime.producer,
          runtime.attemptQueue,
          attemptJob(scenario.accepted.runId, scenario.attempt),
          'Confirmed provider completion',
        );
        await started;
        if (reason === 'canceled')
          await cancelProviderScenarioRun(scenario.accepted.runId);
        else await expireProviderScenarioRun(scenario.accepted.runId);
        await completion;
        const rows = await workerQuery<{ status: string; output_ref: unknown }>(
          'select status,output_ref from app.node_attempts where workspace_id=$1 and id=$2',
          [workspaceId, scenario.attempt.attempt_id],
        );
        expect(rows).toEqual([
          {
            status: 'succeeded',
            output_ref: {
              kind: 'inline',
              value: { channelId: 'C123ABC', messageTs: '1724412345.000100' },
            },
          },
        ]);
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          'Settle controlled run after confirmed success',
        );
        expect(
          await workerQuery(
            'select status from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([{ status: reason }]);
        expect(
          await workerQuery(
            'select status,output_ref from app.node_runs where id=$1',
            [scenario.attempt.node_run_id],
          ),
        ).toEqual(rows);
        expect(providerCalls).toBe(1);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
});
