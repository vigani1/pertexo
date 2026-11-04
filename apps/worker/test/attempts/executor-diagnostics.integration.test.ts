import { beforeAll, beforeEach, expect, it } from 'vitest';
import { createNodeAttemptRunStore } from '@pertexo/core/attempts';
import {
  createRunValuesStore,
  createWorkflowRunDatabase,
} from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  encodeFilePageRecord,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { executorFailureCompletion } from '../../src/attempts/delivery/executor-failure.js';
import { createRunValuesRuntime } from '../../src/attempts/execution/run-values.js';
import {
  installHttpNodeAttemptFixture,
  workerQuery,
  workspaceId,
  actorId,
  apiUrl,
  workerUrl,
  databaseUrl,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  admitProviderScenario,
  advanceScenario,
  closeProofRuntime,
} from './http/fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('Executor diagnostic persistence', () => {
  it.each([
    ['pages', 'file.pages_record', 'One record cannot fit a data page'],
    ['callback', 'execution.configuration', 'Callback waits are unavailable'],
    [
      'run-values',
      'run.values_limit',
      'A run can keep at most ten distinct values',
    ],
  ] as const)(
    'keeps the ordinary %s failure on the step with its actionable reason',
    async (scenarioName, code, summary) => {
      if (fixtureEncryption === undefined) throw new Error('Missing fixture');
      const config = parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 2,
      });
      const store = createNodeAttemptRunStore(config);
      const values = createRunValuesStore(config);
      const reader = createWorkflowRunDatabase(
        parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
      );
      const runtime =
        await createHttpNodeAttemptProofRuntime(fixtureEncryption);
      const signal = new AbortController().signal;
      try {
        const scenario = await admitProviderScenario(runtime, 'slack');
        const job = scenario.attempt;
        const [outbox] = await workerQuery<{ payload_checksum: string }>(
          'select payload_checksum from app.outbox_events where id=$1',
          [job.outbox_id],
        );
        if (outbox === undefined) throw new Error('Missing outbox');
        const claimed = await store.claimDelivery({
          workspaceId,
          runId: scenario.accepted.runId,
          nodeRunId: job.node_run_id,
          attemptId: job.attempt_id,
          delivery: {
            outboxEventId: job.outbox_id,
            payloadChecksum: outbox.payload_checksum,
          },
          workerId: 'diagnostic-proof',
          leaseDurationSeconds: 60,
          signal,
        });
        if (claimed.kind !== 'claimed') throw new Error('Expected claim');
        const lease = claimed.lease;
        let failure: unknown;
        try {
          if (scenarioName === 'pages')
            encodeFilePageRecord('x'.repeat(65_536));
          else if (scenarioName === 'callback')
            await createCoreNodeRegistry().execute({
              definition: { key: 'core.wait', version: 1 },
              executor: { key: 'core.wait', version: 1 },
              config: {
                mode: 'callback',
                timeoutSeconds: 60,
                authentication: { mode: 'secret_url', allowedOrigins: [] },
              },
              input: {},
              signal,
            });
          else {
            const runValues = createRunValuesRuntime(
              values,
              {
                workspaceId,
                runId: lease.runId,
                attemptNumber: lease.attemptNumber,
                nodeId: lease.nodeId,
                invocationKey: lease.invocationKey,
                workerId: lease.workerId,
                nodeRunId: lease.nodeRunId,
                attemptId: lease.attemptId,
                fenceToken: lease.fenceToken,
              },
              () => undefined,
            );
            await runValues.save({
              values: Object.fromEntries(
                Array.from({ length: 10 }, (_, i) => [
                  'key' + String(i),
                  'value',
                ]),
              ),
              signal,
            });
            await runValues.save({ values: { eleventh: 'value' }, signal });
          }
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(NodeExecutorFailure);
        if (!(failure instanceof NodeExecutorFailure)) throw failure;
        expect(failure.safeErrorCode).toBe(code);
        await store.complete({
          lease,
          outcome: executorFailureCompletion(failure),
          signal,
        });
        await advanceScenario(
          runtime,
          lease.runId,
          scenario.coordinatorOutboxes,
          'ordinary diagnostic settlement',
        );
        expect(
          await workerQuery(
            'select status,error_summary from app.workflow_runs where id=$1',
            [lease.runId],
          ),
        ).toEqual([{ status: 'failed', error_summary: null }]);
        expect(
          await workerQuery(
            'select status,safe_error_code,error_summary from app.node_attempts where id=$1',
            [lease.attemptId],
          ),
        ).toEqual([
          {
            status: 'failed',
            safe_error_code: code,
            error_summary: expect.stringContaining(summary) as unknown,
          },
        ]);
        const shown = await reader.get({
          workspaceId,
          actorId,
          runId: lease.runId,
          signal,
        });
        expect(
          shown?.nodes.find((node) => node.id === lease.nodeRunId),
        ).toMatchObject({
          status: 'failed',
          safeErrorCode: code,
          errorSummary: expect.stringContaining(summary) as unknown,
        });
        expect(
          await workerQuery('select status from app.node_runs where id=$1', [
            lease.nodeRunId,
          ]),
        ).toEqual([{ status: 'failed' }]);
      } finally {
        await closeProofRuntime(runtime);
        await store.close();
        await values.close();
        await reader.close();
      }
    },
    30_000,
  );
});
