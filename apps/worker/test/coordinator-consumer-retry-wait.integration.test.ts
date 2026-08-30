import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  Pool,
  QUEUE_NAME,
  Queue,
  adminUrl,
  apiQuery,
  cleanupFixture,
  createCoordinatorRuntime,
  createDueNodeWakeupScanner,
  databaseUrl,
  enabled,
  engineVersion,
  invocationKey,
  parseCheckpoint,
  parseDatabaseConfig,
  randomUUID,
  redisConnection,
  redisUrl,
  restoreServices,
  setupFixture,
  waitFor,
  workerPool,
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
  type CoordinatorAdvanceEngine,
} from './coordinator-consumer.fixtures.js';
import {
  createCoordinatorDispatcher,
  dispatchFairRounds,
} from './support/coordinator-dispatch-fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Retry and Wait outage recovery', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('recovers due retry and Wait work through SQL, Redis outage, BullMQ, and fresh coordination', async () => {
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    try {
      await coordinatorQueue.obliterate({ force: true });
    } finally {
      await coordinatorQueue.close();
    }
    const fixtureAdmin = new Pool({
      connectionString: databaseUrl(adminUrl),
      max: 1,
    });
    try {
      await fixtureAdmin.query(
        `update app.outbox_events
           set published_at=coalesce(published_at,clock_timestamp())
           where job_name='advance-workflow-run'`,
      );
    } finally {
      await fixtureAdmin.end();
    }
    const runId = randomUUID();
    const nodeIds = ['manual', 'set'] as const;
    const invocationKeys = nodeIds.map((nodeId) =>
      invocationKey({ workflowVersionId, nodeId }),
    );
    const providerKeys = nodeIds.map(
      (nodeId) => `due-wakeup-provider-key:${runId}:${nodeId}`,
    );
    const nodeRunIds = nodeIds.map(() => randomUUID());
    const firstAttemptIds = nodeIds.map(() => randomUUID());
    const dueAt = new Date(Date.now() + 500).toISOString();
    const waitingCheckpoint = {
      schemaVersion: 1 as const,
      engineVersion,
      workflowVersionId,
      revision: 0,
      runStatus: 'waiting' as const,
      nextEventSequence: 2,
      readySet: [],
      admittedInvocationKeys: invocationKeys,
      invocations: nodeIds.map((nodeId) => ({
        invocationKey: invocationKey({ workflowVersionId, nodeId }),
        nodeId,
        status: 'waiting' as const,
        attemptNumber: 1,
        resumeAt: dueAt,
        waitKind:
          nodeId === 'manual'
            ? ('retry_backoff' as const)
            : ('node_wait' as const),
        ...(nodeId === 'set'
          ? {
              output: {
                kind: 'inline' as const,
                attemptId: firstAttemptIds[1] as string,
              },
            }
          : {}),
      })),
      joins: [],
      loops: [],
      remainingIterationBudget: 0,
      cancelRequested: false,
      deadlineExpired: false,
    };
    await apiQuery(
      `insert into app.workflow_runs (
           id,workspace_id,workflow_id,workflow_version_id,trigger_type,status
         ) values ($1,$2,$3,$4,'manual','waiting')`,
      [runId, workspaceId, workflowId, workflowVersionId],
    );
    await apiQuery(
      `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,1,'run.queued','{"schemaVersion":1}'::jsonb)`,
      [workspaceId, runId],
    );
    await apiQuery(
      `insert into app.run_checkpoints (
           workflow_run_id,workspace_id,workflow_version_id,revision,
           engine_version,scheduler_state
         ) values ($1,$2,$3,0,$4,$5::jsonb)`,
      [
        runId,
        workspaceId,
        workflowVersionId,
        engineVersion,
        JSON.stringify(waitingCheckpoint),
      ],
    );
    const seedClient = await workerPool.connect();
    try {
      await seedClient.query('begin');
      await seedClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await seedClient.query('set constraints all deferred');
      for (const [index, nodeId] of nodeIds.entries()) {
        if (nodeId === 'manual') {
          await seedClient.query(
            `insert into app.node_runs (
                id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
                status,side_effect_class,provider_idempotency_key,current_attempt_id,
                current_attempt_number,retry_due_at,wait_kind
              ) values ($1,$2,$3,$4,$5,'{}','waiting','idempotent_with_key',$6,$7,1,$8,
                        'retry_backoff')`,
            [
              nodeRunIds[index],
              workspaceId,
              runId,
              nodeId,
              invocationKeys[index],
              providerKeys[index],
              firstAttemptIds[index],
              dueAt,
            ],
          );
          await seedClient.query(
            `insert into app.node_attempts (
                id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
                provider_idempotency_key,safe_error_code,executor_failure_kind,
                executor_error_kind,executor_possibly_dispatched,retry_decision,
                completed_at
              ) values ($1,$2,$3,1,'failed','idempotent_with_key',$4,
                        'execution.rate_limit','retry','rate_limit',false,'retry',
                        clock_timestamp())`,
            [
              firstAttemptIds[index],
              workspaceId,
              nodeRunIds[index],
              providerKeys[index],
            ],
          );
        } else {
          const output = JSON.stringify({
            schemaVersion: 1,
            kind: 'inline',
            value: { preserved: true },
          });
          await seedClient.query(
            `insert into app.node_runs (
                id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
                status,side_effect_class,current_attempt_id,current_attempt_number,
                resume_at,wait_kind,output_ref
              ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7,'node_wait',$8::jsonb)`,
            [
              nodeRunIds[index],
              workspaceId,
              runId,
              nodeId,
              invocationKeys[index],
              firstAttemptIds[index],
              dueAt,
              output,
            ],
          );
          await seedClient.query(
            `insert into app.node_attempts (
                id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
                output_ref,completed_at
              ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb,clock_timestamp())`,
            [firstAttemptIds[index], workspaceId, nodeRunIds[index], output],
          );
        }
      }
      await seedClient.query('commit');
    } catch (error: unknown) {
      await seedClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      seedClient.release();
    }

    const retryEngine: CoordinatorAdvanceEngine = {
      advance: (input) => {
        const current = parseCheckpoint(input.checkpoint);
        if (current.revision > 0)
          return Promise.resolve({
            kind: 'no_change',
            revision: current.revision,
          });
        const invocations = current.invocations.map((invocation) => {
          const {
            resumeAt: _resumeAt,
            waitKind: _waitKind,
            ...active
          } = invocation;
          void _resumeAt;
          void _waitKind;
          return {
            ...active,
            status: 'running' as const,
            attemptNumber: 2,
          };
        });
        return Promise.resolve({
          kind: 'transition',
          plan: {
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
              schemaVersion: 1 as const,
              sequence: index + 2,
              name: 'node.ready' as const,
              occurredAt: input.occurredAt,
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
                nodeId === 'manual'
                  ? ('retry' as const)
                  : ('wait_resume' as const),
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
          },
        });
      },
    };
    const runtimeOptions = {
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      }),
      dueWakeupBatchSize: 10,
      dueWakeupPollIntervalMillis: 25,
      maximumAdmissions: 2,
      releaseCohort: 'for_each_activation' as const,
      redisUrl,
    };
    const beforeDue = await createCoordinatorRuntime(runtimeOptions, {
      engine: retryEngine,
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
    const afterClaim = await createCoordinatorRuntime(runtimeOptions, {
      engine: retryEngine,
    });
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
    const unavailableDispatcher = createCoordinatorDispatcher(
      afterClaim.consumer,
      unavailableRedis.toString(),
    );
    try {
      await expect(
        dispatchFairRounds(unavailableDispatcher, 2),
      ).resolves.toMatchObject({
        claimed: 2,
        failed: 2,
        published: 0,
      });
    } finally {
      await unavailableDispatcher.close().catch(() => undefined);
      redisError.mockRestore();
    }
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

    const dispatcher = createCoordinatorDispatcher(afterClaim.consumer);
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
        await expect(verificationScanner.claimDueWakeups(10)).resolves.toBe(0);
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
      await Promise.allSettled([dispatcher.close(), afterClaim.close()]);
    }
  });
});
