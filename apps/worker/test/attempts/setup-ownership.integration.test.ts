import { NodeAttemptReconciliationRequiredError } from '@pertexo/core/testing';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createNodeAttemptRunStore,
  type NodeAttemptLease,
} from '@pertexo/core/attempts';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  installHttpNodeAttemptFixture,
  withOwner,
  workerQuery,
  waitFor,
  workspaceId,
  workerUrl,
  databaseUrl,
  reclaimProviderScenarioAttempt,
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

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('Lost ownership before attempt setup', () => {
  it.each(['expired', 'replaced'] as const)(
    'leaves healthy work recoverable when its claimed owner is %s',
    async (ownership) => {
      if (fixtureEncryption === undefined) throw new Error('Missing fixture');
      const store = createNodeAttemptRunStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 2,
        }),
      );
      let armed = false,
        providerCalls = 0;
      let oldLease: NodeAttemptLease | undefined,
        replacement: NodeAttemptLease | undefined;
      const runtime = await createHttpNodeAttemptProofRuntime(
        fixtureEncryption,
        {
          afterAttemptClaimed: async (result) => {
            if (
              !armed ||
              result.kind !== 'claimed' ||
              result.lease.nodeId !== 'provider'
            )
              return;
            oldLease = result.lease;
            await withOwner((client) =>
              client.query(
                "update app.node_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
                [oldLease?.attemptId],
              ),
            );
            if (ownership === 'replaced') {
              await reclaimProviderScenarioAttempt({
                attemptId: oldLease.attemptId,
                expectedFence: oldLease.fenceToken,
              });
              const [delivery] = await workerQuery<{
                id: string;
                payload_checksum: string;
              }>(
                'select id,payload_checksum from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and id<>$3 order by created_at desc limit 1',
                [
                  workspaceId,
                  oldLease.attemptId,
                  oldLease.delivery.outboxEventId,
                ],
              );
              if (delivery === undefined)
                throw new Error('Recovery delivery missing');
              const claimed = await store.claimDelivery({
                workspaceId,
                runId: oldLease.runId,
                nodeRunId: oldLease.nodeRunId,
                attemptId: oldLease.attemptId,
                delivery: {
                  outboxEventId: delivery.id,
                  payloadChecksum: delivery.payload_checksum,
                },
                workerId: 'replacement-worker',
                leaseDurationSeconds: 60,
                signal: new AbortController().signal,
              });
              if (claimed.kind !== 'claimed')
                throw new Error('Replacement claim missing');
              replacement = claimed.lease;
            }
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
        const before = await workerQuery(
          'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
          [workspaceId],
        );
        armed = true;
        const publication = await runtime.producer.publish(
          attemptJob(scenario.accepted.runId, scenario.attempt),
        );
        const job = await waitFor(
          () => runtime.attemptQueue.getJob(publication.jobId),
          (value) => value !== undefined,
        );
        if (job === undefined) throw new Error('Missing job');
        await waitFor(
          () => job.getState(),
          (state) => state === 'failed' || state === 'completed',
        );
        expect(
          await workerQuery(
            'select status,error_summary from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([{ status: 'running', error_summary: null }]);
        expect(
          await workerQuery(
            'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
            [workspaceId],
          ),
        ).toEqual(before);
        expect(providerCalls).toBe(0);
        if (oldLease === undefined) throw new Error('Old lease missing');
        await expect(
          store.loadInputs({
            lease: oldLease,
            upstreamNodeOutputs: [],
            signal: new AbortController().signal,
          }),
        ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
        if (replacement !== undefined) {
          expect(
            await workerQuery(
              'select status,lease_owner,fence_token::text as fence_token from app.node_attempts where id=$1',
              [oldLease.attemptId],
            ),
          ).toEqual([
            {
              status: 'running',
              lease_owner: replacement.workerId,
              fence_token: String(replacement.fenceToken),
            },
          ]);
          await expect(
            store.loadInputs({
              lease: replacement,
              upstreamNodeOutputs: [],
              signal: new AbortController().signal,
            }),
          ).resolves.toMatchObject({ control: { kind: 'none' } });
        } else {
          await reclaimProviderScenarioAttempt({
            attemptId: oldLease.attemptId,
            expectedFence: oldLease.fenceToken,
          });
          expect(
            await workerQuery(
              'select status,lease_owner from app.node_attempts where id=$1',
              [oldLease.attemptId],
            ),
          ).toEqual([{ status: 'ready', lease_owner: null }]);
          expect(
            await workerQuery(
              'select exists(select 1 from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and id<>$3) as queued',
              [
                workspaceId,
                oldLease.attemptId,
                oldLease.delivery.outboxEventId,
              ],
            ),
          ).toEqual([{ queued: true }]);
        }
      } finally {
        await closeProofRuntime(runtime);
        await store.close();
      }
    },
    30_000,
  );
});
