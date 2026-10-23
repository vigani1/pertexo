import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  attemptDelivery,
  connectionId,
  waitFor,
  withOwner,
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

export function registerAcceptedHttpBindings(): void {
  it('uses an already accepted HTTP binding after connection sharing becomes restricted', async () => {
    if (!fixtureEncryption)
      throw new Error('HTTP attempt fixture encryption is missing');
    const runtime = await createHttpNodeAttemptProofRuntime(fixtureEncryption);
    try {
      const scenario = await admitProviderScenario(runtime, 'http');
      await withOwner((client) =>
        client.query(
          "update app.connections set access_mode='restricted',sharing_revision=sharing_revision+1 where workspace_id=$1 and id=$2",
          [workspaceId, connectionId],
        ),
      );
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Delegated HTTP after sharing change',
      );
      expect(
        await workerQuery('select status from app.node_attempts where id=$1', [
          scenario.attempt.attempt_id,
        ]),
      ).toEqual([{ status: 'succeeded' }]);
      expect(runtime.transportRequests).toHaveLength(1);
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Delegated HTTP completion',
      );
      expect(
        await workerQuery('select status from app.workflow_runs where id=$1', [
          scenario.accepted.runId,
        ]),
      ).toEqual([{ status: 'succeeded' }]);
    } finally {
      await withOwner((client) =>
        client.query(
          "update app.connections set access_mode='workspace',sharing_revision=sharing_revision+1 where workspace_id=$1 and id=$2",
          [workspaceId, connectionId],
        ),
      );
      await closeProofRuntime(runtime);
    }
  }, 30_000);

  it('persists a transient HTTP credential-resolution failure and lets the pinned coordinator schedule exactly one retry', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    let httpResolutions = 0;
    const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
      beforeConnectionResolve: (input) => {
        if (input.expectedProviderKey === 'http') {
          httpResolutions += 1;
          if (httpResolutions === 1)
            throw new Error('transient connection-store outage');
        }
        return Promise.resolve();
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'http');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Transient HTTP attempt',
      );
      const failed = await workerQuery<{
        attempt_status: string;
        continuation_count: string;
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        inbox_completed: string;
        node_status: string;
        retry_decision: string | null;
      }>(
        `select attempt.status attempt_status,attempt.dispatch_marked_at,
                attempt.executor_error_kind,attempt.executor_failure_kind,
                attempt.executor_possibly_dispatched,attempt.retry_decision,
                node.status node_status,
                (select count(*)::text from app.inbox_receipts receipt
                  where receipt.workspace_id=attempt.workspace_id
                    and receipt.message_id=$3 and receipt.completed_at is not null)
                  inbox_completed,
                (select count(*)::text from app.outbox_events outbox
                  where outbox.workspace_id=attempt.workspace_id
                    and outbox.aggregate_id=$4
                    and outbox.job_name='advance-workflow-run') continuation_count
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$2`,
        [
          workspaceId,
          scenario.attempt.attempt_id,
          scenario.attempt.outbox_id,
          scenario.accepted.runId,
        ],
      );
      expect(failed[0]).toEqual({
        attempt_status: 'failed',
        continuation_count: '3',
        dispatch_marked_at: null,
        executor_error_kind: 'provider',
        executor_failure_kind: 'retry',
        executor_possibly_dispatched: false,
        inbox_completed: '1',
        node_status: 'running',
        retry_decision: 'pending',
      });
      expect(runtime.transportRequests).toHaveLength(0);

      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Transient HTTP retry decision',
      );
      const decision = await waitFor(
        () =>
          workerQuery<{
            retry_decision: string | null;
            retry_due_at: Date | null;
          }>(
            `select attempt.retry_decision,node.retry_due_at
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceId, scenario.attempt.attempt_id],
          ),
        (rows) => rows[0]?.retry_decision === 'retry',
      );
      expect(decision[0]?.retry_due_at).toBeInstanceOf(Date);
      const retryDueAt = decision[0]?.retry_due_at;
      if (retryDueAt === null || retryDueAt === undefined)
        throw new Error('Transient HTTP retry due time missing');
      const delayMillis = retryDueAt.getTime() - Date.now();
      if (delayMillis > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, delayMillis + 25),
        );
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Transient HTTP retry due admission',
      );
      const retry = await attemptDelivery(
        scenario.accepted.runId,
        'provider',
        2,
      );
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, retry),
        'Recovered HTTP attempt',
      );
      const recovered = await workerQuery<{
        attempt_count: string;
        attempt_numbers: number[];
        provider_keys: (string | null)[];
        statuses: string[];
      }>(
        `select count(*)::text attempt_count,
                array_agg(attempt.attempt_number order by attempt.attempt_number) attempt_numbers,
                array_agg(attempt.provider_idempotency_key order by attempt.attempt_number) provider_keys,
                array_agg(attempt.status order by attempt.attempt_number) statuses
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and node.workflow_run_id=$2
             and node.node_id='provider'`,
        [workspaceId, scenario.accepted.runId],
      );
      expect(recovered[0]).toEqual({
        attempt_count: '2',
        attempt_numbers: [1, 2],
        provider_keys: [null, null],
        statuses: ['failed', 'succeeded'],
      });
      expect(runtime.transportRequests).toHaveLength(1);
      expect(httpResolutions).toBe(2);
    } finally {
      await closeProofRuntime(runtime);
    }
  }, 30_000);
}
