import { it, expect } from 'vitest';

import {
  NodeAttemptStateCorruptError,
  asAdmin,
  asRuntime,
  checkpoint,
  nodeAttemptStore,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerMatchesExecutorFailureReplayFields(): void {
  it.each([undefined, 30_000])(
    'matches executor-failure replay fields before and after coordinator decision (hint %s)',
    async (minimumRetryDelayMillis) => {
      const lease = await claimDispatchAttempt(
        `executor-replay-${randomUUID()}`,
      );
      const outcome = {
        ...(minimumRetryDelayMillis === undefined
          ? {}
          : { minimumRetryDelayMillis }),
        errorKind: 'network',
        failureKind: 'retry',
        possiblyDispatched: true,
        safeErrorCode: 'node.provider_unavailable',
        status: 'executor_failure',
      } as const;
      const first = await nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      });
      expect(first.kind).toBe('committed');
      const storedHint = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          'select executor_retry_after_millis from app.node_attempts where workspace_id=$1 and id=$2',
          [workspaceA, lease.attemptId],
        ),
      );
      expect(storedHint.rows).toEqual([
        { executor_retry_after_millis: minimumRetryDelayMillis ?? null },
      ]);
      const loaded = await ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: lease.runId,
        signal: new AbortController().signal,
      });
      if (loaded.kind !== 'ready')
        throw new Error('Failure observation missing');
      expect(loaded.state.observations).toContainEqual(
        expect.objectContaining({
          kind: 'attempt_failure',
          ...(minimumRetryDelayMillis === undefined
            ? {}
            : { minimumRetryDelayMillis }),
        }),
      );
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
      for (const changed of [
        { ...outcome, failureKind: 'failed' as const },
        { ...outcome, errorKind: 'timeout' as const },
        {
          ...outcome,
          minimumRetryDelayMillis: (minimumRetryDelayMillis ?? 0) + 1,
        },
        { ...outcome, possiblyDispatched: false },
        { ...outcome, safeErrorCode: 'node.changed_error' },
      ])
        await expect(
          nodeAttemptStore.complete({
            lease,
            outcome: changed,
            signal: new AbortController().signal,
          }),
        ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);

      await asAdmin((client) =>
        client.query(
          `with finalized as (
           update app.node_attempts set retry_decision='failed'
            where workspace_id=$1 and id=$2 returning node_run_id
         )
         update app.node_runs node
            set status='failed',safe_error_code=$3,
                completed_at=clock_timestamp()
           from finalized
          where node.workspace_id=$1 and node.id=finalized.node_run_id`,
          [workspaceA, lease.attemptId, outcome.safeErrorCode],
        ),
      );
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });

      const effects = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          completed_receipts: number;
          continuation_outbox: number;
        }>(
          `select
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run') continuation_outbox,
             (select count(*)::int from app.inbox_receipts
               where workspace_id=$1 and message_id=$3
                 and completed_at is not null) completed_receipts`,
          [workspaceA, lease.runId, lease.delivery.outboxEventId],
        ),
      );
      expect(effects.rows).toEqual([
        { completed_receipts: 1, continuation_outbox: 2 },
      ]);
    },
  );

  it('advances a persisted mixed-case executor failure without corrupting its code', async () => {
    const lease = await claimDispatchAttempt(`mixed-failure-${randomUUID()}`);
    const outcome = {
      errorKind: 'provider',
      failureKind: 'failed',
      possiblyDispatched: false,
      safeErrorCode: 'Provider.Failure',
      status: 'executor_failure',
    } as const;
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId: lease.runId,
      signal: new AbortController().signal,
    });
    expect(loaded.kind).toBe('ready');
    if (loaded.kind !== 'ready') throw new Error('coordinator state missing');
    expect(
      loaded.state.observations.some(
        (observation) =>
          typeof observation === 'object' &&
          observation !== null &&
          'kind' in observation &&
          observation.kind === 'attempt_failure' &&
          'safeErrorCode' in observation &&
          observation.safeErrorCode === 'Provider.Failure',
      ),
    ).toBe(true);
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: lease.runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 1,
          expectedNextEventSequence: 4,
          consumedThroughEventSequence: 4,
          checkpoint: checkpoint({
            revision: 2,
            runStatus: 'failed',
            nextEventSequence: 7,
            admittedInvocationKeys: [lease.invocationKey],
            invocations: [
              {
                invocationKey: lease.invocationKey,
                nodeId: lease.nodeId,
                status: 'failed',
                attemptNumber: 1,
              },
            ],
          }),
          events: [
            {
              sequence: 5,
              name: 'node.failed',
              occurredAt: '2026-09-27T12:00:00.000Z',
              invocationKey: lease.invocationKey,
              nodeId: lease.nodeId,
              attemptNumber: 1,
              reasonCode: 'Provider.Failure',
            },
            {
              sequence: 6,
              name: 'run.failed',
              occurredAt: '2026-09-27T12:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 2 });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ code: string; run_status: string }>(
          `select attempt.safe_error_code code,run.status run_status
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
             join app.workflow_runs run on run.id=node.workflow_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, lease.attemptId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [{ code: 'Provider.Failure', run_status: 'failed' }],
    });
  });
}
