import { JOB_NAME } from '@pertexo/queue';

import {
  createNodeAttemptRunStore,
  type NodeAttemptLease,
} from '@pertexo/core/attempts';

import { NodeAttemptReconciliationRequiredError } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  databaseUrl,
  reclaimProviderScenarioAttempt,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} from '../../../support/attempts/http-node-attempt.js';

import {
  fixtureEncryption,
  createOwnedBarrier,
  publishAndWaitForCompletion,
  attemptJob,
  admitProviderScenario,
  closeProofRuntime,
} from '../fixture.js';

export function registerHeartbeatRecovery(): void {
  it('recovers a keyed provider attempt after heartbeat ownership is lost without accepting stale completion or exact redelivery', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    let oldLease: NodeAttemptLease | undefined;
    const providerStarted = createOwnedBarrier('heartbeat-loss provider start');
    const providerKeys: string[] = [];
    let providerInFlight = false;
    const firstRuntime = await createHttpNodeAttemptProofRuntime(encryption, {
      afterAttemptClaimed: (result) => {
        if (result.kind === 'claimed' && result.lease.nodeId === 'provider')
          oldLease = result.lease;
        return Promise.resolve();
      },
      beforeHeartbeat: (input) => {
        if (input.lease.nodeId === 'provider' && providerInFlight)
          throw new Error('heartbeat ownership lost');
        return Promise.resolve();
      },
      heartbeatIntervalMillis: 50,
      leaseDurationSeconds: 1,
      sendEmailNotification: async (input) => {
        await input.beforeDispatch();
        providerKeys.push(input.idempotencyKey);
        providerInFlight = true;
        providerStarted.resolve();
        const signal = input.signal;
        if (signal === undefined)
          throw new Error('Email scenario signal is missing');
        await new Promise<never>((_resolve, reject) => {
          const rejectAborted = () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          };
          if (signal.aborted) rejectAborted();
          else signal.addEventListener('abort', rejectAborted, { once: true });
        });
        throw new Error('Aborted email request unexpectedly resumed');
      },
    });
    try {
      const scenario = await admitProviderScenario(firstRuntime, 'email');
      const firstPublished = await firstRuntime.producer.publish(
        attemptJob(scenario.accepted.runId, scenario.attempt),
      );
      await providerStarted.promise;
      const abortedJob = await waitFor(
        () => firstRuntime.attemptQueue.getJob(firstPublished.jobId),
        (candidate) => candidate !== undefined,
      );
      if (abortedJob === undefined)
        throw new Error('Heartbeat-loss email job missing');
      // A repeat of the job finds the attempt running and leaves it to the
      // lease, so the job ends without settling anything.
      await waitFor(
        () => abortedJob.getState(),
        (state) => state === 'completed' || state === 'failed',
      );
      const abandoned = await workerQuery<{
        dispatch_marked_at: Date | null;
        fence_token: string;
        inbox_completed: string;
        lease_expires_at: Date;
        provider_idempotency_key: string;
        status: string;
      }>(
        `select attempt.status,attempt.fence_token::text,
                attempt.lease_expires_at,attempt.dispatch_marked_at,
                attempt.provider_idempotency_key,
                (select count(receipt.completed_at)::text
                   from app.inbox_receipts receipt
                  where receipt.workspace_id=attempt.workspace_id
                    and receipt.message_id=$3) inbox_completed
           from app.node_attempts attempt
          where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, scenario.attempt.attempt_id, scenario.attempt.outbox_id],
      );
      const abandonedAttempt = abandoned[0];
      if (abandonedAttempt === undefined)
        throw new Error('Abandoned provider attempt missing');
      expect(abandonedAttempt).toMatchObject({
        fence_token: '1',
        inbox_completed: '0',
        status: 'running',
      });
      expect(abandonedAttempt.dispatch_marked_at).toBeInstanceOf(Date);
      expect(abandonedAttempt.lease_expires_at).toBeInstanceOf(Date);
      expect(abandonedAttempt.provider_idempotency_key).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      expect(providerKeys).toEqual([abandonedAttempt.provider_idempotency_key]);
      const lease = oldLease;
      if (lease === undefined) throw new Error('Heartbeat-loss lease missing');

      await closeProofRuntime(firstRuntime);
      const leaseDelay =
        abandonedAttempt.lease_expires_at.getTime() - Date.now();
      if (leaseDelay > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, leaseDelay + 25),
        );
      const reclaimed = await reclaimProviderScenarioAttempt({
        attemptId: scenario.attempt.attempt_id,
        expectedFence: 1,
      });
      expect(reclaimed).toMatchObject({
        outcome: 'reclaimed',
        result: {
          fenceToken: 2,
          outcome: 'reclaimed',
        },
      });
      const reclaimedOutboxEventId = reclaimed.result.outboxEventId;
      if (typeof reclaimedOutboxEventId !== 'string')
        throw new Error('Reclaim outbox event missing');
      expect(reclaimedOutboxEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );

      const staleStore = createNodeAttemptRunStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 1,
        }),
      );
      try {
        await expect(
          staleStore.complete({
            lease,
            outcome: {
              status: 'succeeded',
              output: { emailId: '3e6b2d7e-80fd-4b80-852c-735169874e1c' },
            },
            signal: new AbortController().signal,
          }),
        ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
      } finally {
        await staleStore.close();
      }

      const secondRuntime = await createHttpNodeAttemptProofRuntime(
        encryption,
        {
          sendEmailNotification: async (input) => {
            await input.beforeDispatch();
            providerKeys.push(input.idempotencyKey);
            return {
              kind: 'succeeded',
              emailId: '3e6b2d7e-80fd-4b80-852c-735169874e1c',
            };
          },
        },
      );
      try {
        await Promise.all([
          secondRuntime.attempts.consumer.waitUntilReady(5_000),
          secondRuntime.producer.waitUntilReady(5_000),
        ]);
        const recoveryDelivery = {
          name: JOB_NAME.executeNodeAttempt,
          data: {
            workspaceId,
            runId: scenario.accepted.runId,
            nodeRunId: scenario.attempt.node_run_id,
            attemptId: scenario.attempt.attempt_id,
            outboxEventId: reclaimedOutboxEventId,
          },
        };
        const recoveredJob = await publishAndWaitForCompletion(
          secondRuntime.producer,
          secondRuntime.attemptQueue,
          recoveryDelivery,
          'Reclaimed email attempt',
        );
        const recovered = await workerQuery<{
          completed_receipts: string;
          continuation_count: string;
          fence_token: string;
          node_status: string;
          provider_idempotency_key: string;
          status: string;
        }>(
          `select attempt.status,attempt.fence_token::text,
                  attempt.provider_idempotency_key,node.status node_status,
                  (select count(receipt.completed_at)::text
                     from app.inbox_receipts receipt
                    where receipt.workspace_id=attempt.workspace_id
                      and receipt.message_id in ($3,$4)) completed_receipts,
                  (select count(*)::text from app.outbox_events outbox
                    where outbox.workspace_id=attempt.workspace_id
                      and outbox.aggregate_id=$5
                      and outbox.job_name='advance-workflow-run') continuation_count
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceId,
            scenario.attempt.attempt_id,
            scenario.attempt.outbox_id,
            reclaimedOutboxEventId,
            scenario.accepted.runId,
          ],
        );
        expect(recovered).toEqual([
          {
            completed_receipts: '1',
            continuation_count: '3',
            fence_token: '3',
            node_status: 'succeeded',
            provider_idempotency_key: abandonedAttempt.provider_idempotency_key,
            status: 'succeeded',
          },
        ]);
        expect(providerKeys).toEqual([
          abandonedAttempt.provider_idempotency_key,
          abandonedAttempt.provider_idempotency_key,
        ]);
        const beforeDuplicate = recovered[0];
        await recoveredJob.remove();
        await publishAndWaitForCompletion(
          secondRuntime.producer,
          secondRuntime.attemptQueue,
          recoveryDelivery,
          'Exact reclaimed email redelivery',
        );
        await expect(
          workerQuery<{
            completed_receipts: string;
            continuation_count: string;
            fence_token: string;
            node_status: string;
            provider_idempotency_key: string;
            status: string;
          }>(
            `select attempt.status,attempt.fence_token::text,
                    attempt.provider_idempotency_key,node.status node_status,
                    (select count(receipt.completed_at)::text
                       from app.inbox_receipts receipt
                      where receipt.workspace_id=attempt.workspace_id
                        and receipt.message_id in ($3,$4)) completed_receipts,
                    (select count(*)::text from app.outbox_events outbox
                      where outbox.workspace_id=attempt.workspace_id
                        and outbox.aggregate_id=$5
                        and outbox.job_name='advance-workflow-run') continuation_count
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
              where attempt.workspace_id=$1 and attempt.id=$2`,
            [
              workspaceId,
              scenario.attempt.attempt_id,
              scenario.attempt.outbox_id,
              reclaimedOutboxEventId,
              scenario.accepted.runId,
            ],
          ),
        ).resolves.toEqual([beforeDuplicate]);
        expect(providerKeys).toHaveLength(2);
      } finally {
        await closeProofRuntime(secondRuntime);
      }
    } finally {
      providerStarted.dispose();
      await closeProofRuntime(firstRuntime);
    }
  }, 30_000);
}
