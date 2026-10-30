import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  cancelProviderScenarioRun,
  expireProviderScenarioRun,
  waitFor,
  workerQuery,
  workspaceId,
} from '../../../support/attempts/http-node-attempt.js';

import {
  fixtureEncryption,
  createOwnedBarrier,
  publishAndWaitForCompletion,
  attemptJob,
  advanceScenario,
  prepareAmbiguousEmailRetry,
  closeProofRuntime,
} from '../fixture.js';

export function registerEmailRecoveryAmbiguity(): void {
  it.each([
    ['canceled', 'early'],
    ['timed_out', 'early'],
    ['canceled', 'heartbeat'],
    ['timed_out', 'heartbeat'],
  ] as const)(
    'preserves prior keyed email ambiguity when %s is observed on the retry %s path before redispatch',
    async (reason, entryPath) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      let emailResolutions = 0;
      let providerCalls = 0;
      const providerKeys: string[] = [];
      const retryResolution = createOwnedBarrier(
        `${reason} retry resolution entry`,
      );
      const retryResolutionRelease = createOwnedBarrier(
        `${reason} retry resolution release`,
        25_000,
      );
      const durableAbort = createOwnedBarrier(
        `${reason} durable abort observation`,
      );
      const requestControl = (runId: string) =>
        reason === 'canceled'
          ? cancelProviderScenarioRun(runId)
          : expireProviderScenarioRun(runId);
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        afterAttemptClaimed: async (result) => {
          if (
            entryPath === 'early' &&
            result.kind === 'claimed' &&
            result.lease.nodeId === 'provider' &&
            result.lease.attemptNumber === 2
          )
            await requestControl(result.lease.runId);
        },
        afterHeartbeat: (result) => {
          if (entryPath === 'heartbeat' && result.control.kind === 'abort')
            durableAbort.resolve();
          return Promise.resolve();
        },
        beforeConnectionResolve: async (input) => {
          if (input.expectedProviderKey !== 'email') return;
          emailResolutions += 1;
          if (entryPath === 'heartbeat' && emailResolutions === 2) {
            retryResolution.resolve();
            await retryResolutionRelease.promise;
          }
        },
        heartbeatIntervalMillis: 50,
        sendEmailNotification: async (input) => {
          await input.beforeDispatch();
          providerCalls += 1;
          providerKeys.push(input.idempotencyKey);
          throw new Error('provider connection reset after possible dispatch');
        },
      });
      try {
        const scenario = await prepareAmbiguousEmailRetry(runtime);
        if (entryPath === 'early') {
          await publishAndWaitForCompletion(
            runtime.producer,
            runtime.attemptQueue,
            attemptJob(scenario.accepted.runId, scenario.retry),
            `Early ${reason} email retry`,
          );
        } else {
          const published = await runtime.producer.publish(
            attemptJob(scenario.accepted.runId, scenario.retry),
          );
          await retryResolution.promise;
          await requestControl(scenario.accepted.runId);
          await durableAbort.promise;
          retryResolutionRelease.resolve();
          const job = await waitFor(
            () => runtime.attemptQueue.getJob(published.jobId),
            (candidate) => candidate !== undefined,
          );
          if (job === undefined)
            throw new Error('Blocked email retry is missing');
          await waitFor(
            () => job.getState(),
            (state) => state === 'completed' || state === 'failed',
          );
          expect(await job.getState()).toBe('completed');
        }

        const attempts = await workerQuery<{
          attempt_number: number;
          dispatch_marked_at: Date | null;
          executor_failure_kind: string | null;
          executor_possibly_dispatched: boolean | null;
          provider_dispatch_binding: string | null;
          provider_idempotency_key: string | null;
          safe_error_code: string | null;
          status: string;
        }>(
          `select attempt.attempt_number,attempt.status,
                  attempt.dispatch_marked_at,attempt.safe_error_code,
                  attempt.executor_failure_kind,
                  attempt.executor_possibly_dispatched,
                  attempt.provider_idempotency_key,
                  node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and node.workflow_run_id=$2
              and node.node_id='provider'
            order by attempt.attempt_number`,
          [workspaceId, scenario.accepted.runId],
        );
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.dispatch_marked_at).toBeInstanceOf(Date);
        expect(attempts[0]?.provider_idempotency_key).toMatch(
          /^v1\.[0-9a-f]{64}$/u,
        );
        expect(attempts[0]).toMatchObject({
          attempt_number: 1,
          executor_failure_kind: 'retry',
          executor_possibly_dispatched: true,
        });
        expect(attempts[1]).toMatchObject({
          attempt_number: 2,
          dispatch_marked_at: null,
          executor_failure_kind: null,
          executor_possibly_dispatched: null,
          provider_dispatch_binding: attempts[0]?.provider_dispatch_binding,
          provider_idempotency_key: attempts[0]?.provider_idempotency_key,
          safe_error_code: 'execution.outcome_unknown',
          status: 'outcome_unknown',
        });
        expect(providerCalls).toBe(1);
        expect(providerKeys).toEqual([attempts[0]?.provider_idempotency_key]);
        expect(emailResolutions).toBe(entryPath === 'early' ? 1 : 2);
        await expect(
          workerQuery<{ completed: string }>(
            `select count(completed_at)::text completed
               from app.inbox_receipts
              where workspace_id=$1 and message_id=$2`,
            [workspaceId, scenario.retry.outbox_id],
          ),
        ).resolves.toEqual([{ completed: '1' }]);

        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          `${entryPath} ${reason} email terminal decision`,
        );
        await expect(
          workerQuery<{ node_status: string; run_status: string }>(
            `select node.status node_status,run.status run_status
               from app.node_runs node
               join app.workflow_runs run
                 on run.workspace_id=node.workspace_id
                and run.id=node.workflow_run_id
              where node.workspace_id=$1 and node.workflow_run_id=$2
                and node.node_id='provider'`,
            [workspaceId, scenario.accepted.runId],
          ),
        ).resolves.toEqual([
          { node_status: 'outcome_unknown', run_status: 'outcome_unknown' },
        ]);
      } finally {
        retryResolution.dispose();
        durableAbort.dispose();
        retryResolutionRelease.resolve();
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
}
