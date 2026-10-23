import { expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
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
  publishAndWaitForCompletion,
  attemptJob,
  admitProviderScenario,
  advanceScenario,
  closeProofRuntime,
} from '../fixture.js';

export function registerDispatchEvidenceFailures(): void {
  it('keeps an internal HTTP dispatch-evidence failure non-retryable through persisted coordinator policy', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
      beforeRegistryExecute: (request) => {
        if (request.definition.key === 'http.request')
          throw new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'internal',
            possiblyDispatched: false,
          });
        return Promise.resolve();
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'http');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Internal HTTP attempt',
      );
      const failed = await workerQuery<{
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        retry_decision: string | null;
      }>(
        `select dispatch_marked_at,executor_error_kind,executor_failure_kind,
                executor_possibly_dispatched,retry_decision
           from app.node_attempts where workspace_id=$1 and id=$2`,
        [workspaceId, scenario.attempt.attempt_id],
      );
      expect(failed[0]).toEqual({
        dispatch_marked_at: null,
        executor_error_kind: 'internal',
        executor_failure_kind: 'failed',
        executor_possibly_dispatched: false,
        retry_decision: 'pending',
      });
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Internal HTTP terminal decision',
      );
      const terminal = await waitFor(
        () =>
          workerQuery<{
            attempt_count: string;
            node_status: string;
            retry_decision: string;
            run_status: string;
          }>(
            `select attempt.retry_decision,node.status node_status,
                    run.status run_status,
                    (select count(*)::text from app.node_attempts candidate
                      where candidate.workspace_id=attempt.workspace_id
                        and candidate.node_run_id=attempt.node_run_id) attempt_count
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
               join app.workflow_runs run
                 on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, scenario.attempt.attempt_id],
          ),
        (rows) => rows[0]?.retry_decision === 'failed',
      );
      expect(terminal[0]).toEqual({
        attempt_count: '1',
        node_status: 'failed',
        retry_decision: 'failed',
        run_status: 'failed',
      });
      expect(runtime.transportRequests).toHaveLength(0);
    } finally {
      await closeProofRuntime(runtime);
    }
  }, 30_000);

  it.each(['canceled', 'timed_out'] as const)(
    'persists durable %s arriving after claim but before provider execution',
    async (reason) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      let controlled = false;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        afterAttemptClaimed: async (result) => {
          if (
            result.kind !== 'claimed' ||
            result.lease.nodeId !== 'provider' ||
            controlled
          )
            return;
          controlled = true;
          if (reason === 'canceled')
            await cancelProviderScenarioRun(result.lease.runId);
          else await expireProviderScenarioRun(result.lease.runId);
        },
      });
      try {
        const scenario = await admitProviderScenario(runtime, 'http');
        await publishAndWaitForCompletion(
          runtime.producer,
          runtime.attemptQueue,
          attemptJob(scenario.accepted.runId, scenario.attempt),
          `Pre-execution ${reason} HTTP attempt`,
        );
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
        expect(completed).toEqual([
          {
            attempt_status: reason,
            dispatch_marked_at: null,
            inbox_completed: '1',
            safe_error_code:
              reason === 'canceled'
                ? 'execution.canceled'
                : 'execution.deadline_exceeded',
          },
        ]);
        expect(controlled).toBe(true);
        expect(runtime.transportRequests).toHaveLength(0);
        await advanceScenario(
          runtime,
          scenario.accepted.runId,
          scenario.coordinatorOutboxes,
          `Pre-execution ${reason} terminal coordinator`,
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
          (rows) => rows[0]?.node_status === reason,
        );
        expect(terminal).toEqual([{ node_status: reason, run_status: reason }]);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
}
