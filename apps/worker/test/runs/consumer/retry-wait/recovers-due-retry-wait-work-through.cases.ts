import {
  createDueNodeWakeupScanner,
  createRunAdvanceStore,
  parseDatabaseConfig,
  type RunAdvanceStore,
} from '@pertexo/database/testing';
import { QUEUE_NAME } from '@pertexo/queue';
import {
  invocationKey,
  parseCheckpoint,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';

import { expect, it, vi } from 'vitest';

import {
  createCoordinatorDispatcher,
  dispatchFairRounds,
} from '../../../support/coordinator/dispatch.js';
import {
  databaseUrl,
  dispatcherUrl,
  redisConnection,
  redisUrl,
  waitFor,
  workerQuery,
  workerUrl,
  workflowVersionId,
  workspaceId,
} from './fixture.js';
import { seedDueWakeups } from './seed.js';
import { testCoordinatorRuntime } from '../../../support/runtime-factories.js';

export function registerRecoversDueRetryWaitWorkThrough(): void {
  it('recovers due retry and Wait work through SQL, Redis outage, BullMQ, and fresh coordination', async () => {
    const seed = await seedDueWakeups();
    const { runId, nodeIds, providerKeys, waitingCheckpoint } = seed;
    let dueAt = seed.dueAt;

    // Establish the real-clock observation window only after the comparatively
    // expensive durable fixture setup. Creating this timestamp before those
    // writes made the supposed pre-due assertion scheduler-speed dependent.
    dueAt = new Date(Date.now() + 2_000).toISOString();
    const dueCheckpoint = {
      ...waitingCheckpoint,
      invocations: waitingCheckpoint.invocations.map((invocation) => ({
        ...invocation,
        resumeAt: dueAt,
      })),
    };
    await workerQuery(
      `update app.run_checkpoints
          set scheduler_state=$3::jsonb
        where workspace_id=$1 and workflow_run_id=$2`,
      [workspaceId, runId, JSON.stringify(dueCheckpoint)],
    );
    await workerQuery(
      `update app.node_runs
          set retry_due_at=case when node_id='manual' then $3::timestamptz else null end,
              resume_at=case when node_id='set' then $3::timestamptz else null end
        where workspace_id=$1 and workflow_run_id=$2`,
      [workspaceId, runId, dueAt],
    );

    // A scripted decision that admits both due nodes on the first advance.
    const retryDecide: Parameters<RunAdvanceStore['advance']>[1] = (state) => {
      const current = parseCheckpoint(state.checkpoint);
      const occurredAt = new Date().toISOString();
      if (current.revision > 0) return Promise.resolve({ kind: 'no_change' });
      const invocations = current.invocations.map((invocation) => {
        const {
          resumeAt: _resumeAt,
          waitKind: _waitKind,
          ...active
        } = invocation;
        return {
          ...active,
          status: 'running' as const,
          attemptNumber: 2,
        };
      });
      const plan: WorkflowTransitionPlan = {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: {
          ...current,
          revision: 1,
          runStatus: 'running',
          nextEventSequence: 4,
          invocations,
        },
        events: nodeIds.map((nodeId, index) => ({
          sequence: index + 2,
          name: 'node.ready' as const,
          occurredAt,
          invocationKey: invocationKey({ workflowVersionId, nodeId }),
          nodeId,
          attemptNumber: 1,
        })),
        nodeRunAdmissions: [],
        attempts: nodeIds.map((nodeId) => ({
          invocationKey: invocationKey({ workflowVersionId, nodeId }),
          nodeId,
          attemptNumber: 2,
          admissionKind:
            nodeId === 'manual' ? ('retry' as const) : ('wait_resume' as const),
          sideEffectClass:
            nodeId === 'manual'
              ? ('idempotent_with_key' as const)
              : ('safe' as const),
          ...(nodeId === 'manual'
            ? {
                providerIdempotencyKey: `due-wakeup-provider-key:${runId}:${nodeId}`,
              }
            : {}),
        })),
      };
      return Promise.resolve({ kind: 'transition', previous: current, plan });
    };
    const retryStore = createRunAdvanceStore(
      parseDatabaseConfig({ connectionString: databaseUrl(workerUrl), max: 2 }),
    );
    const advance = (input: Parameters<RunAdvanceStore['advance']>[0]) =>
      retryStore.advance(input, retryDecide);
    const runtimeOptions = {
      maintenanceDatabase: parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      }),
      dueWakeupBatchSize: 10,
      dueWakeupPollIntervalMillis: 25,
      maximumAdmissions: 2,
      redisUrl,
    };
    const beforeDue = await testCoordinatorRuntime(runtimeOptions, {
      advance,
    });
    try {
      await beforeDue.consumer.waitUntilReady(5_000);
      // This real-clock interval is the proof that the periodic scanner does
      // not claim a wake-up before its durable due_at timestamp.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await expect(
        workerQuery<{ attempts: string; wakeups: string }>(
          `select
               (select count(*)::text from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 where node.workflow_run_id=$1) attempts,
               (select count(*)::text from app.outbox_events
                 where aggregate_id=$1 and job_name='advance-workflow-run') wakeups`,
          [runId],
        ),
      ).resolves.toEqual([{ attempts: '2', wakeups: '0' }]);
    } finally {
      await beforeDue.close();
    }

    // Advancing to the database-owned due timestamp is intentionally real
    // time; a fake clock would not exercise PostgreSQL clock_timestamp().
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(dueAt) - Date.now() + 25)),
    );
    const afterClaim = await testCoordinatorRuntime(runtimeOptions, {
      advance,
    });
    try {
      await afterClaim.consumer.waitUntilReady(5_000);
      await waitFor(
        () =>
          workerQuery<{ attempts: string; wakeups: string }>(
            `select
               (select count(*)::text from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 where node.workflow_run_id=$1) attempts,
               (select count(*)::text from app.outbox_events
                 where aggregate_id=$1 and job_name='advance-workflow-run') wakeups`,
            [runId],
          ),
        (rows) => rows[0]?.attempts === '2' && rows[0].wakeups === '2',
      );

      const unavailableRedis = new URL(redisUrl);
      unavailableRedis.port = '1';
      const redisError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const unavailableDispatcher = await createCoordinatorDispatcher(
        unavailableRedis.toString(),
      );
      let unavailableCloseError: unknown;
      try {
        await expect(
          dispatchFairRounds(unavailableDispatcher, 2),
        ).resolves.toMatchObject({
          claimed: 2,
          failed: 2,
          published: 0,
        });
      } finally {
        await unavailableDispatcher.close().catch((error: unknown) => {
          unavailableCloseError = error;
        });
        redisError.mockRestore();
      }
      expect(unavailableCloseError).toBeInstanceOf(AggregateError);
      expect((unavailableCloseError as AggregateError).message).toBe(
        'Outbox dispatcher shutdown failed',
      );
      const closeFailures = (unavailableCloseError as AggregateError)
        .errors as unknown[];
      expect(
        closeFailures.some(
          (error) =>
            error instanceof Error &&
            /Stream isn't writeable|offline queue/u.test(error.message),
        ),
      ).toBe(true);
      await waitFor(
        () =>
          workerQuery<{ available: string }>(
            `select count(*) filter (where available_at <= clock_timestamp())::text as available
             from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'
               and published_at is null and failed_at is null`,
            [runId],
          ),
        (rows) => rows[0]?.available === '2',
      );

      const dispatcher = await createCoordinatorDispatcher();
      try {
        await dispatcher.checkReadiness();
        await expect(dispatchFairRounds(dispatcher, 2)).resolves.toMatchObject({
          claimed: 2,
          published: 2,
        });
        const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
          connection: redisConnection(),
        });
        try {
          const wakeupJobs = await waitFor(
            () =>
              coordinatorQueue.getJobs([
                'active',
                'completed',
                'failed',
                'waiting',
              ]),
            (jobs) => jobs.length === 2,
          );
          await waitFor(
            () => Promise.all(wakeupJobs.map((job) => job.getState())),
            (states) =>
              states.every((state) => ['completed', 'failed'].includes(state)),
          );
          const failed = await coordinatorQueue.getJobs(['failed']);
          if (failed.length > 0)
            throw new Error(
              `due wakeup coordinator failed: ${failed.map((job) => job.failedReason).join('; ')}`,
            );
        } finally {
          await coordinatorQueue.close();
        }
        const facts = await waitFor(
          () =>
            workerQuery<{
              attempt_count: string;
              attempt_outboxes: string;
              event_count: string;
              provider_keys: (string | null)[];
              retry_events: string;
            }>(
              `select
                 (select count(*)::text from app.node_attempts attempt
                   join app.node_runs node on node.workspace_id=attempt.workspace_id
                    and node.id=attempt.node_run_id
                   where node.workflow_run_id=$1) attempt_count,
                 (select array_agg(attempt.provider_idempotency_key order by node.node_id,attempt.attempt_number)
                   from app.node_attempts attempt
                   join app.node_runs node on node.workspace_id=attempt.workspace_id
                    and node.id=attempt.node_run_id
                   where node.workflow_run_id=$1) provider_keys,
                 (select count(*)::text from app.outbox_events
                   where payload->>'runId'=$1::text and job_name='execute-node-attempt') attempt_outboxes,
                 (select count(*)::text from app.run_events
                   where workflow_run_id=$1) event_count,
                 (select count(*)::text from app.run_events
                   where workflow_run_id=$1 and type='node.retry_scheduled') retry_events`,
              [runId],
            ),
          (rows) => rows[0]?.attempt_count === '4',
        );
        const fact = facts[0];
        if (fact === undefined) throw new Error('due wakeup facts missing');
        expect(fact).toEqual({
          attempt_count: '4',
          attempt_outboxes: '2',
          event_count: '3',
          provider_keys: [providerKeys[0], providerKeys[0], null, null],
          retry_events: '0',
        });
        const verificationScanner = createDueNodeWakeupScanner(
          runtimeOptions.database,
        );
        try {
          await expect(verificationScanner.claimDueWakeups(10)).resolves.toBe(
            0,
          );
        } finally {
          await verificationScanner.close();
        }
        await expect(
          workerQuery<{ attempts: string; wakeups: string }>(
            `select
               (select count(*)::text from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 where node.workflow_run_id=$1) attempts,
               (select count(*)::text from app.outbox_events
                 where aggregate_id=$1 and job_name='advance-workflow-run') wakeups`,
            [runId],
          ),
        ).resolves.toEqual([{ attempts: '4', wakeups: '2' }]);
      } finally {
        await dispatcher.close();
      }
    } finally {
      await Promise.all([afterClaim.close(), retryStore.close()]);
    }
  });
}
