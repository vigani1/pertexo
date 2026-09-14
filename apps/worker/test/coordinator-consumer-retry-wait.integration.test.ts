import { randomUUID } from 'node:crypto';

import {
  createDeadlineWakeupScanner,
  createDueNodeWakeupScanner,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import {
  PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_WAIT_STAGED,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { invocationKey, parseCheckpoint } from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import type { CoordinatorAdvanceEngine } from '../src/execution/coordinator-handler.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { coordinatorFixture } from './coordinator-consumer.fixtures.js';
import {
  createCoordinatorDispatcher,
  dispatchFairRounds,
} from './support/coordinator-dispatch-fixtures.js';
import {
  acceptWaitRun,
  cancelFixtureRun,
  waitForAttemptOutbox,
  waitForCoordinatorOutbox,
} from './support/coordinator-run-fixtures.js';

const {
  activateRelease,
  adminUrl,
  apiQuery,
  databaseUrl,
  enabled,
  engineVersion,
  ownerQuery,
  redisConnection,
  redisUrl,
  restoreServicesAndClose,
  setup,
  waitFor,
  waitWorkflowVersionId,
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
} = coordinatorFixture;
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Retry and Wait outage recovery', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);

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
    let dueAt = new Date(Date.now() + 60_000).toISOString();
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
    const seedClient = await coordinatorFixture.workerPool.connect();
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
        afterClaim.consumer,
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

      const dispatcher = await createCoordinatorDispatcher(afterClaim.consumer);
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
      await afterClaim.close();
    }
  });

  it('commits simultaneous cancellation and deadline facts against a genuinely suspended Wait', async () => {
    await activateRelease(PLATFORM_REGISTRY_RELEASE_WAIT_STAGED);
    await activateRelease(PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE);
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    await Promise.all([
      coordinatorQueue.obliterate({ force: true }),
      attemptQueue.obliterate({ force: true }),
    ]);
    const accepted = await acceptWaitRun();
    const database = parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 6,
    });
    const producer = createQueueProducer({ redisUrl });
    let coordinator = await createCoordinatorRuntime({
      database,
      maximumAdmissions: 1,
      releaseCohort: 'wait_activation',
      redisUrl,
    });
    const attempts = await createNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 10,
        releaseCohort: 'wait_activation',
        redisUrl,
        workerId: `wait-control-${randomUUID()}`,
      },
      {
        registry: createPlatformNodeRegistryForRelease(
          PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE,
        ),
        runtimeCapabilities: {
          connections: () => ({
            resolve: () => Promise.reject(new Error('not used')),
          }),
          artifacts: () => ({
            write: () => Promise.reject(new Error('not used')),
          }),
        },
      },
    );
    const coordinatorOutboxes = [accepted.outboxEventId];
    const attemptOutboxes: string[] = [];
    const publishCoordinator = async (
      outboxEventId: string,
      expectedRevision: number,
    ) => {
      const published = await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          outboxEventId,
        },
      });
      const result = await waitFor(
        async () => {
          const [rows, job] = await Promise.all([
            workerQuery<{ revision: number }>(
              `select revision from app.run_checkpoints
                 where workspace_id=$1 and workflow_run_id=$2`,
              [workspaceId, accepted.runId],
            ),
            coordinatorQueue.getJob(published.jobId),
          ]);
          return {
            failedReason: job?.failedReason,
            revision: rows[0]?.revision,
            stacktrace: job?.stacktrace,
            state: await job?.getState(),
          };
        },
        ({ revision, state }) =>
          state === 'failed' ||
          (revision === expectedRevision && state === 'completed'),
      );
      if (result.state !== 'completed')
        throw new Error(
          `Wait coordinator failed: ${result.failedReason ?? 'unknown'} ${JSON.stringify(result.stacktrace)}`,
        );
    };
    const execute = async (
      expectedNodeId: 'manual' | 'wait',
      expectedStatus: 'succeeded' | 'waiting',
    ) => {
      const attempt = await waitForAttemptOutbox(
        accepted.runId,
        attemptOutboxes,
      );
      attemptOutboxes.push(attempt.outboxEventId);
      const published = await producer.publish({
        name: JOB_NAME.executeNodeAttempt,
        data: {
          schemaVersion: 1,
          workspaceId,
          runId: accepted.runId,
          nodeRunId: attempt.nodeRunId,
          attemptId: attempt.attemptId,
          outboxEventId: attempt.outboxEventId,
        },
      });
      const result = await waitFor(
        async () => {
          const [rows, job] = await Promise.all([
            workerQuery<{ node_id: string; status: string }>(
              `select node_id,status from app.node_runs
                 where workspace_id=$1 and id=$2`,
              [workspaceId, attempt.nodeRunId],
            ),
            attemptQueue.getJob(published.jobId),
          ]);
          return {
            failedReason: job?.failedReason,
            nodeId: rows[0]?.node_id,
            state: await job?.getState(),
            status: rows[0]?.status,
          };
        },
        ({ state, status }) =>
          state === 'failed' ||
          (status === expectedStatus && state === 'completed'),
      );
      if (
        result.state !== 'completed' ||
        result.nodeId !== expectedNodeId ||
        result.status !== expectedStatus
      )
        throw new Error(
          `Wait attempt failed: ${result.failedReason ?? 'unknown'}`,
        );
    };

    try {
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      await publishCoordinator(accepted.outboxEventId, 1);
      await execute('manual', 'succeeded');
      const manualContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(manualContinuation);
      await publishCoordinator(manualContinuation, 2);
      await execute('wait', 'waiting');
      const waitContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(waitContinuation);
      await publishCoordinator(waitContinuation, 3);
      const waiting = await workerQuery<{
        resume_at: Date | null;
        scheduler_state: unknown;
        status: string;
        wait_kind: string | null;
      }>(
        `select node.status,node.resume_at,node.wait_kind,checkpoint.scheduler_state
             from app.node_runs node
             join app.run_checkpoints checkpoint
               on checkpoint.workflow_run_id=node.workflow_run_id
            where node.workspace_id=$1 and node.workflow_run_id=$2
              and node.node_id='wait'`,
        [workspaceId, accepted.runId],
      );
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.resume_at).toBeInstanceOf(Date);
      expect(waiting[0]).toMatchObject({
        status: 'waiting',
        wait_kind: 'node_wait',
      });

      await Promise.all([attempts.close(), coordinator.close()]);
      await ownerQuery(
        `update app.workflow_runs
            set deadline_at=created_at+interval '1 millisecond',
                deadline_wakeup_at=null,updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, accepted.runId],
      );
      const scanner = createDeadlineWakeupScanner(database);
      try {
        await expect(scanner.claimDueWakeups(10)).resolves.toBe(1);
      } finally {
        await scanner.close();
      }
      await cancelFixtureRun(
        accepted.runId,
        'cancel wins simultaneous Wait deadline',
      );
      const controlOutboxes = await waitFor(
        () =>
          workerQuery<{ id: string }>(
            `select id from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run'
                 and not (id=any($3::uuid[]))
               order by created_at,id`,
            [workspaceId, accepted.runId, coordinatorOutboxes],
          ),
        (rows) => rows.length === 2,
      );
      const firstControlOutbox = controlOutboxes[0]?.id;
      const secondControlOutbox = controlOutboxes[1]?.id;
      if (firstControlOutbox === undefined || secondControlOutbox === undefined)
        throw new Error('Wait control outboxes are incomplete');

      coordinator = await createCoordinatorRuntime({
        database,
        maximumAdmissions: 1,
        releaseCohort: 'wait_activation',
        redisUrl,
      });
      await coordinator.consumer.waitUntilReady(5_000);
      await publishCoordinator(firstControlOutbox, 4);
      const terminal = await workerQuery<{
        attempt_count: string;
        attempt_outboxes: string;
        cancel_events: string;
        canceled_events: string;
        scheduler_state: unknown;
        status: string;
        timed_out_events: string;
        wait_kind: string | null;
        resume_at: Date | null;
      }>(
        `select run.status,checkpoint.scheduler_state,
                wait_node.wait_kind,wait_node.resume_at,
                (select count(*)::text from app.node_attempts attempt
                  join app.node_runs node on node.id=attempt.node_run_id
                 where node.workspace_id=run.workspace_id
                   and node.workflow_run_id=run.id) attempt_count,
                (select count(*)::text from app.outbox_events outbox
                 where outbox.payload->>'runId'=run.id::text
                   and outbox.job_name='execute-node-attempt') attempt_outboxes,
                (select count(*)::text from app.run_events event
                 where event.workflow_run_id=run.id
                   and event.type='run.cancel_requested') cancel_events,
                (select count(*)::text from app.run_events event
                 where event.workflow_run_id=run.id
                   and event.type='node.canceled') canceled_events,
                (select count(*)::text from app.run_events event
                 where event.workflow_run_id=run.id
                   and event.type='node.timed_out') timed_out_events
           from app.workflow_runs run
           join app.run_checkpoints checkpoint on checkpoint.workflow_run_id=run.id
           join app.node_runs wait_node on wait_node.workflow_run_id=run.id
             and wait_node.node_id='wait'
          where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        attempt_count: '2',
        attempt_outboxes: '2',
        cancel_events: '1',
        canceled_events: '1',
        resume_at: null,
        status: 'canceled',
        timed_out_events: '0',
        wait_kind: null,
      });
      const terminalCheckpoint = parseCheckpoint(terminal[0]?.scheduler_state);
      expect(terminalCheckpoint).toMatchObject({
        cancelRequested: true,
        deadlineExpired: true,
        runStatus: 'canceled',
      });
      expect(
        terminalCheckpoint.invocations.find(({ nodeId }) => nodeId === 'wait'),
      ).toMatchObject({ nodeId: 'wait', status: 'canceled' });

      await coordinator.close();
      coordinator = await createCoordinatorRuntime({
        database,
        maximumAdmissions: 1,
        releaseCohort: 'wait_activation',
        redisUrl,
      });
      await coordinator.consumer.waitUntilReady(5_000);
      await publishCoordinator(secondControlOutbox, 4);
      await expect(
        workerQuery<{
          attempts: string;
          events: string;
          revision: number;
        }>(
          `select checkpoint.revision,
                  (select count(*)::text from app.node_attempts attempt
                    join app.node_runs node on node.id=attempt.node_run_id
                   where node.workflow_run_id=$2) attempts,
                  (select count(*)::text from app.run_events event
                   where event.workflow_run_id=$2) events
             from app.run_checkpoints checkpoint
            where checkpoint.workspace_id=$1
              and checkpoint.workflow_run_id=$2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([
        {
          attempts: '2',
          events: '12',
          revision: 4,
        },
      ]);
      expect(
        invocationKey({
          workflowVersionId: waitWorkflowVersionId,
          nodeId: 'wait',
        }),
      ).toBe(
        terminalCheckpoint.invocations.find(({ nodeId }) => nodeId === 'wait')
          ?.invocationKey,
      );
    } finally {
      await Promise.allSettled([
        attempts.close(),
        coordinator.close(),
        producer.close(),
        attemptQueue.close(),
        coordinatorQueue.close(),
      ]);
    }
  }, 60_000);
});
