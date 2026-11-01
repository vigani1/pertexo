import { it, expect } from 'vitest';

import {
  NodeAttemptStateCorruptError,
  asAdmin,
  asRuntime,
  nodeAttemptStore,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerRollsBackFullCompletionTransaction(): void {
  it('rolls back the full completion transaction after attempt update and after outbox insert', async () => {
    const completionState = (
      lease: Awaited<ReturnType<typeof claimDispatchAttempt>>,
    ) =>
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          advance_outbox: number;
          attempt_output: unknown;
          attempt_status: string;
          completed_receipts: number;
          node_output: unknown;
          node_status: string;
          terminal_events: number;
        }>(
          `select attempt.status attempt_status,
                  attempt.output_ref attempt_output,
                  node.status node_status,node.output_ref node_output,
                  (select count(*)::int from app.run_events
                    where workspace_id=$1 and workflow_run_id=$3
                      and type='node.succeeded') terminal_events,
                  (select count(*)::int from app.outbox_events
                    where workspace_id=$1 and aggregate_id=$3
                      and job_name='advance-workflow-run') advance_outbox,
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

    for (const boundary of ['attempt_update', 'outbox_insert'] as const) {
      const lease = await claimDispatchAttempt(
        `completion-rollback-${boundary}-${randomUUID()}`,
      );
      const before = await completionState(lease);
      const functionName = `q35_fail_${boundary}`;
      const triggerName = `q35_fail_${boundary}`;
      const triggerTable =
        boundary === 'attempt_update' ? 'node_attempts' : 'inbox_receipts';
      const triggerColumn =
        boundary === 'attempt_update' ? 'status' : 'completed_at';
      const triggerPredicate =
        boundary === 'attempt_update'
          ? `NEW.id='${lease.attemptId}'::uuid and NEW.status='succeeded'`
          : `NEW.message_id='${lease.delivery.outboxEventId}'::uuid and NEW.completed_at is not null`;
      try {
        await asAdmin(async (client) => {
          await client.query(
            `create function app.${functionName}() returns trigger
               language plpgsql as $$
               begin
                 raise exception 'q35 injected ${boundary} failure';
               end
               $$`,
          );
          await client.query(
            `create trigger ${triggerName}
               after update of ${triggerColumn} on app.${triggerTable}
               for each row when (${triggerPredicate})
               execute function app.${functionName}()`,
          );
        });

        await expect(
          nodeAttemptStore.complete({
            lease,
            outcome: { status: 'succeeded', output: { boundary } },
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(`q35 injected ${boundary} failure`);
      } finally {
        await asAdmin(async (client) => {
          await client.query(
            `drop trigger if exists ${triggerName} on app.${triggerTable}`,
          );
          await client.query(`drop function if exists app.${functionName}()`);
        });
      }

      const after = await completionState(lease);
      expect(after.rows).toEqual(before.rows);
      expect(after.rows).toEqual([
        {
          advance_outbox: 1,
          attempt_output: null,
          attempt_status: 'running',
          completed_receipts: 0,
          node_output: null,
          node_status: 'running',
          terminal_events: 0,
        },
      ]);
    }
  });

  it('requires exact safe error code and summary for ordinary failure replay', async () => {
    const lease = await claimDispatchAttempt(`failure-replay-${randomUUID()}`);
    const outcome = {
      errorSummary: 'provider rejected the request',
      safeErrorCode: 'node.provider_rejected',
      status: 'failed',
    } as const;
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    for (const changed of [
      { ...outcome, safeErrorCode: 'node.changed_error' },
      { ...outcome, errorSummary: 'changed summary' },
    ])
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: changed,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);

    const effects = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        completed_receipts: number;
        continuation_outbox: number;
        error_summary: string;
        safe_error_code: string;
      }>(
        `select attempt.safe_error_code,attempt.error_summary,
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=$3
                 and job_name='advance-workflow-run') continuation_outbox,
             (select count(*)::int from app.inbox_receipts
               where workspace_id=$1 and message_id=$4
                 and completed_at is not null) completed_receipts
           from app.node_attempts attempt
          where attempt.workspace_id=$1 and attempt.id=$2`,
        [
          workspaceA,
          lease.attemptId,
          lease.runId,
          lease.delivery.outboxEventId,
        ],
      ),
    );
    expect(effects.rows).toEqual([
      {
        completed_receipts: 1,
        continuation_outbox: 2,
        error_summary: outcome.errorSummary,
        safe_error_code: outcome.safeErrorCode,
      },
    ]);
  });

  it.each([
    ['execution.file_input', 'CSV record 3 has 1 column; the header has 2.'],
    ['execution.attempt_invalid', 'Use a date like 2026-10-19.'],
  ] as const)(
    'persists the %s summary and compares it on duplicate completion',
    async (safeErrorCode, errorSummary) => {
      const lease = await claimDispatchAttempt(
        `failure-summary-${randomUUID()}`,
        { sideEffectClass: 'safe' },
      );
      const outcome = {
        status: 'executor_failure',
        failureKind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
        safeErrorCode,
        errorSummary,
      } as const;
      const signal = new AbortController().signal;
      expect(
        (await nodeAttemptStore.complete({ lease, outcome, signal })).kind,
      ).toBe('committed');
      await expect(
        nodeAttemptStore.complete({ lease, outcome, signal }),
      ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: { ...outcome, errorSummary: 'Different summary' },
          signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
      const stored = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          'select error_summary from app.node_attempts where workspace_id=$1 and id=$2',
          [workspaceA, lease.attemptId],
        ),
      );
      expect(stored.rows).toEqual([{ error_summary: outcome.errorSummary }]);
    },
  );
}
