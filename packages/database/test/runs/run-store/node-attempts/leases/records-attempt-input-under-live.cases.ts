import { it, expect } from 'vitest';
import { NodeAttemptReconciliationRequiredError } from '../../../../../src/testing.js';

import {
  NodeAttemptStateCorruptError,
  asAdmin,
  asRuntime,
  nodeAttemptStore,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { storedNodeRunInput, claimDispatchAttempt } from '../fixture.js';

export function registerRecordsAttemptInputUnderLive(): void {
  it('records an attempt input under its live lease, and nothing once it is lost', async () => {
    const lease = await claimDispatchAttempt(`record-input-${randomUUID()}`);
    const signal = new AbortController().signal;
    const storedInput = () => storedNodeRunInput(lease.nodeRunId);

    await expect(
      nodeAttemptStore.recordInput?.({
        lease,
        input: { orderId: 'A-17' },
        signal,
      }),
    ).resolves.toEqual({ recorded: true });
    const recorded = {
      kind: 'inline',
      value: { orderId: 'A-17' },
    };
    await expect(storedInput()).resolves.toEqual(recorded);

    // Over the inline bound, or once the attempt is aborted, nothing changes.
    await expect(
      nodeAttemptStore.recordInput?.({
        lease,
        input: 'x'.repeat(300_000),
        signal,
      }),
    ).resolves.toEqual({ recorded: false });
    await expect(
      nodeAttemptStore.recordInput?.({
        lease,
        input: { orderId: 'A-18' },
        signal: AbortSignal.abort(),
      }),
    ).resolves.toEqual({ recorded: false });
    await expect(storedInput()).resolves.toEqual(recorded);

    await asAdmin((client) =>
      client.query(
        `update app.node_attempts
            set fence_token=fence_token+1
          where workspace_id=$1 and id=$2`,
        [workspaceA, lease.attemptId],
      ),
    );
    await expect(
      nodeAttemptStore.recordInput?.({
        lease,
        input: { orderId: 'B-2' },
        signal,
      }),
    ).resolves.toEqual({ recorded: false });
    await expect(storedInput()).resolves.toEqual(recorded);
  });

  it('records no input when a live lease identifies a different run or step', async () => {
    const lease = await claimDispatchAttempt(`record-identity-${randomUUID()}`);
    const signal = new AbortController().signal;
    for (const changed of [
      { workflowVersionId: randomUUID() },
      { runId: randomUUID() },
      { nodeRunId: randomUUID() },
      { nodeId: `${lease.nodeId}-other` },
      { invocationKey: `${lease.invocationKey}-other` },
      { attemptNumber: lease.attemptNumber + 1 },
    ]) {
      await expect(
        nodeAttemptStore.recordInput?.({
          lease: { ...lease, ...changed },
          input: { unaccepted: true },
          signal,
        }),
      ).resolves.toEqual({ recorded: false });
    }
    await expect(storedNodeRunInput(lease.nodeRunId)).resolves.toBeNull();
    await expect(
      nodeAttemptStore.recordInput?.({
        lease,
        input: { accepted: true },
        signal,
      }),
    ).resolves.toEqual({ recorded: true });
  });

  it('rejects independently stale lease ownership without terminal side effects', async () => {
    for (const mutation of [
      {
        name: 'expired lease',
        sql: `update app.node_attempts
              set lease_expires_at=clock_timestamp()-interval '1 second'
              where workspace_id=$1 and id=$2`,
      },
      {
        name: 'changed owner',
        sql: `update app.node_attempts set lease_owner='replacement-worker'
              where workspace_id=$1 and id=$2`,
      },
      {
        name: 'wrong current attempt',
        sql: `update app.node_runs
              set current_attempt_id=null,current_attempt_number=null
              where workspace_id=$1 and current_attempt_id=$2`,
      },
    ]) {
      const lease = await claimDispatchAttempt(
        `stale-${mutation.name.replaceAll(' ', '-')}-${randomUUID()}`,
      );
      await asAdmin((client) =>
        client.query(mutation.sql, [workspaceA, lease.attemptId]),
      );

      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: { status: 'succeeded', output: { accepted: false } },
          signal: new AbortController().signal,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof NodeAttemptReconciliationRequiredError ||
          error instanceof NodeAttemptStateCorruptError,
      );

      const state = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          attempt_output: unknown;
          attempt_status: string;
          completed_receipts: number;
          continuation_outbox: number;
          node_output: unknown;
          terminal_events: number;
        }>(
          `select attempt.status attempt_status,
                    attempt.output_ref attempt_output,
                    node.output_ref node_output,
                    (select count(*)::int from app.run_events
                      where workspace_id=$1 and workflow_run_id=$3
                        and type in (
                          'node.succeeded','node.failed','node.canceled',
                          'node.timed_out','node.outcome_unknown'
                        )) terminal_events,
                    (select count(*)::int from app.outbox_events
                      where workspace_id=$1 and aggregate_id=$3
                        and job_name='advance-workflow-run') continuation_outbox,
                    (select count(*)::int from app.inbox_receipts
                      where workspace_id=$1 and message_id=$4
                        and completed_at is not null) completed_receipts
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceA,
            lease.attemptId,
            lease.runId,
            lease.delivery.outboxEventId,
          ],
        ),
      );
      expect(state.rows).toEqual([
        {
          attempt_output: null,
          attempt_status: 'running',
          completed_receipts: 0,
          continuation_outbox: 1,
          node_output: null,
          terminal_events: 0,
        },
      ]);
    }
  });
}
