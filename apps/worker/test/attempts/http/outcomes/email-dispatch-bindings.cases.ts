import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  attemptDelivery,
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

export function registerEmailDispatchBindings(): void {
  it('keeps an email dispatch key and prior ambiguity when credential resolution fails before the retry can redispatch', async () => {
    const encryption = fixtureEncryption;
    if (encryption === undefined)
      throw new Error('HTTP attempt fixture encryption is missing');
    const providerKeys: string[] = [];
    let emailResolutions = 0;
    const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
      beforeConnectionResolve: (input) => {
        if (input.expectedProviderKey === 'email') {
          emailResolutions += 1;
          if (emailResolutions === 2)
            throw new Error('connection store unavailable before redispatch');
        }
        return Promise.resolve();
      },
      sendEmailNotification: async (input) => {
        await input.beforeDispatch();
        providerKeys.push(input.idempotencyKey);
        throw new Error('provider connection reset after possible dispatch');
      },
    });
    try {
      const scenario = await admitProviderScenario(runtime, 'email');
      await publishAndWaitForCompletion(
        runtime.producer,
        runtime.attemptQueue,
        attemptJob(scenario.accepted.runId, scenario.attempt),
        'Ambiguous email attempt',
      );
      const first = await workerQuery<{
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        provider_dispatch_binding: string | null;
        provider_idempotency_key: string | null;
      }>(
        `select attempt.dispatch_marked_at,attempt.executor_error_kind,
                attempt.executor_failure_kind,attempt.executor_possibly_dispatched,
                attempt.provider_idempotency_key,node.provider_dispatch_binding
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, scenario.attempt.attempt_id],
      );
      const firstAttempt = first[0];
      if (firstAttempt === undefined)
        throw new Error('Ambiguous email attempt missing');
      expect(firstAttempt).toMatchObject({
        executor_error_kind: 'network',
        executor_failure_kind: 'retry',
        executor_possibly_dispatched: true,
      });
      expect(firstAttempt.dispatch_marked_at).toBeInstanceOf(Date);
      expect(firstAttempt.provider_dispatch_binding).toMatch(
        /^email:sha256:[0-9a-f]{64}$/u,
      );
      expect(firstAttempt.provider_idempotency_key).toMatch(
        /^v1\.[0-9a-f]{64}$/u,
      );
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Ambiguous email retry decision',
      );
      const retryDue = await waitFor(
        () =>
          workerQuery<{ retry_due_at: Date | null }>(
            `select retry_due_at from app.node_runs
               where workspace_id=$1 and workflow_run_id=$2 and node_id='provider'`,
            [workspaceId, scenario.accepted.runId],
          ),
        (rows) => rows[0]?.retry_due_at instanceof Date,
      );
      const retryDueAt = retryDue[0]?.retry_due_at;
      if (retryDueAt === null || retryDueAt === undefined)
        throw new Error('Ambiguous email retry due time missing');
      const delayMillis = retryDueAt.getTime() - Date.now();
      if (delayMillis > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, delayMillis + 25),
        );
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Ambiguous email retry due admission',
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
        'Pre-redispatch email resolution failure',
      );
      const attempts = await workerQuery<{
        attempt_number: number;
        dispatch_marked_at: Date | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        provider_dispatch_binding: string | null;
        provider_idempotency_key: string | null;
      }>(
        `select attempt.attempt_number,attempt.dispatch_marked_at,
                attempt.executor_failure_kind,attempt.executor_possibly_dispatched,
                attempt.provider_idempotency_key,node.provider_dispatch_binding
           from app.node_attempts attempt
           join app.node_runs node
             on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
           where attempt.workspace_id=$1 and node.workflow_run_id=$2
             and node.node_id='provider'
           order by attempt.attempt_number`,
        [workspaceId, scenario.accepted.runId],
      );
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({
        attempt_number: 2,
        dispatch_marked_at: null,
        executor_failure_kind: 'outcome_unknown',
        executor_possibly_dispatched: true,
        provider_dispatch_binding: attempts[0]?.provider_dispatch_binding,
        provider_idempotency_key: attempts[0]?.provider_idempotency_key,
      });
      expect(providerKeys).toEqual([attempts[0]?.provider_idempotency_key]);
      expect(emailResolutions).toBe(2);
      await advanceScenario(
        runtime,
        scenario.accepted.runId,
        scenario.coordinatorOutboxes,
        'Ambiguous email terminal decision',
      );
      await expect(
        workerQuery<{ attempt_count: string; node_status: string }>(
          `select node.status node_status,
                  (select count(*)::text from app.node_attempts attempt
                    where attempt.workspace_id=node.workspace_id
                      and attempt.node_run_id=node.id) attempt_count
             from app.node_runs node
             where node.workspace_id=$1 and node.workflow_run_id=$2
               and node.node_id='provider'`,
          [workspaceId, scenario.accepted.runId],
        ),
      ).resolves.toEqual([
        { attempt_count: '2', node_status: 'outcome_unknown' },
      ]);
    } finally {
      await closeProofRuntime(runtime);
    }
  }, 30_000);
}
