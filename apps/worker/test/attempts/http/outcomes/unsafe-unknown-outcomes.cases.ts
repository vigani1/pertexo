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
  attemptJob,
  admitProviderScenario,
  advanceScenario,
  closeProofRuntime,
} from '../fixture.js';

export function registerUnsafeUnknownOutcomes(): void {
  it.each(['canceled', 'timed_out'] as const)(
    'persists unsafe outcome_unknown when durable %s arrives during a heartbeat-controlled provider request',
    async (reason) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      const providerStarted = createOwnedBarrier(
        `${reason} HTTP provider start`,
      );
      let providerCalls = 0;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        dispatchHttp: async (request) => {
          providerCalls += 1;
          providerStarted.resolve();
          const signal = request.signal;
          if (signal === undefined)
            throw new Error('HTTP scenario signal is missing');
          await new Promise<never>((_resolve, reject) => {
            const rejectAborted = () => {
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            };
            if (signal.aborted) rejectAborted();
            else
              signal.addEventListener('abort', rejectAborted, { once: true });
          });
          throw new Error('Aborted provider request unexpectedly resumed');
        },
      });
      try {
        // A POST: a GET only reads, so stopping it is simply canceled.
        const scenario = await admitProviderScenario(runtime, 'http_post');
        const published = await runtime.producer.publish(
          attemptJob(scenario.accepted.runId, scenario.attempt),
        );
        await providerStarted.promise;
        if (reason === 'canceled')
          await cancelProviderScenarioRun(scenario.accepted.runId);
        else await expireProviderScenarioRun(scenario.accepted.runId);
        const job = await waitFor(
          () => runtime.attemptQueue.getJob(published.jobId),
          (candidate) => candidate !== undefined,
        );
        if (job === undefined) throw new Error('Controlled HTTP job missing');
        await waitFor(
          () => job.getState(),
          (state) => state === 'completed' || state === 'failed',
        );
        expect(await job.getState()).toBe('completed');
        const completed = await workerQuery<{
          attempt_status: string;
          dispatch_marked_at: Date | null;
          inbox_completed: string;
          safe_error_code: string;
        }>(
          `select attempt.status attempt_status,attempt.dispatch_marked_at,
                  attempt.safe_error_code,
                  (select count(receipt.completed_at)::text
                     from app.inbox_receipts receipt
                    where receipt.workspace_id=attempt.workspace_id
                      and receipt.message_id=$3) inbox_completed
             from app.node_attempts attempt
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceId,
            scenario.attempt.attempt_id,
            scenario.attempt.outbox_id,
          ],
        );
        const completedAttempt = completed[0];
        if (completedAttempt === undefined)
          throw new Error('Completed provider attempt missing');
        expect(completedAttempt).toMatchObject({
          attempt_status: 'outcome_unknown',
          inbox_completed: '1',
          safe_error_code: 'execution.outcome_unknown',
        });
        expect(completedAttempt.dispatch_marked_at).toBeInstanceOf(Date);
        expect(providerCalls).toBe(1);
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          `During-execution ${reason} terminal coordinator`,
        );
        const terminal = await waitFor(
          () =>
            workerQuery<{ node_status: string; run_status: string }>(
              `select node.status node_status,run.status run_status
                 from app.node_runs node
                 join app.workflow_runs run
                   on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.node_id='provider'`,
              [workspaceId, scenario.accepted.runId],
            ),
          (rows) => rows[0]?.node_status === 'outcome_unknown',
        );
        expect(terminal).toEqual([
          { node_status: 'outcome_unknown', run_status: 'outcome_unknown' },
        ]);
      } finally {
        providerStarted.dispose();
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
}
