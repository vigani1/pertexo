import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  QUEUE_NAME,
  Queue,
  apiDatabase,
  cleanupFixture,
  createQueueProducer,
  databaseUrl,
  enabled,
  parseCheckpoint,
  redisConnection,
  redisUrl,
  requestWorkflowRunCancellation,
  restoreServices,
  setupFixture,
  spawn,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
  type ChildProcess,
} from './coordinator-consumer.fixtures.js';
import {
  acceptForEachRun,
  waitForCoordinatorOutbox,
} from './support/coordinator-run-fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('For Each cancellation recovery', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('recovers bounded For Each batches and cancellation from PostgreSQL on fresh workers', async () => {
    const producer = createQueueProducer({ redisUrl });
    const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
      connection: redisConnection(),
    });
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    const startWorkers = async (): Promise<ChildProcess> => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          new URL('./for-each-worker-process-fixture.ts', import.meta.url)
            .pathname,
        ],
        {
          cwd: new URL('../', import.meta.url).pathname,
          env: {
            ...process.env,
            FOR_EACH_DATABASE_URL: databaseUrl(workerUrl),
            FOR_EACH_REDIS_URL: redisUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await new Promise<void>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          reject(new Error(`For Each child startup timed out: ${stderr}`));
        }, 10_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('"ready":true')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `For Each child exited during startup (${String(code)}): ${stderr}`,
            ),
          );
        });
      });
      return child;
    };
    let workers = await startWorkers();
    const stopWorkers = async () => {
      if (workers.exitCode !== null) return;
      workers.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        workers.once('exit', () => {
          resolve();
        });
      });
    };
    const eraseRedisAndRestart = async () => {
      await stopWorkers();
      await Promise.all([
        coordinatorQueue.obliterate({ force: true }),
        attemptQueue.obliterate({ force: true }),
      ]);
      workers = await startWorkers();
    };

    const runFixture = async (cancelBetweenBatches: boolean) => {
      const accepted = await acceptForEachRun();
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
              stacktrace: job?.stacktrace,
              revision: rows[0]?.revision,
              state: await job?.getState(),
            };
          },
          ({ revision, state }) =>
            revision === expectedRevision || state === 'failed',
        );
        if (result.revision !== expectedRevision)
          throw new Error(
            `For Each coordinator failed: ${result.failedReason ?? 'unknown'} ${JSON.stringify(result.stacktrace)}`,
          );
      };
      const continueAfter = async (expectedRevision: number) => {
        const outbox = await waitForCoordinatorOutbox(
          accepted.runId,
          coordinatorOutboxes,
        );
        coordinatorOutboxes.push(outbox);
        await publishCoordinator(outbox, expectedRevision);
        return outbox;
      };
      const execute = async (nodeId: string, ordinal?: number) => {
        const rows = await waitFor(
          () =>
            workerQuery<{
              attempt_id: string;
              node_run_id: string;
              outbox_id: string;
            }>(
              `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id
                   from app.outbox_events outbox
                   join app.node_attempts attempt on attempt.id=outbox.aggregate_id
                   join app.node_runs node on node.id=attempt.node_run_id
                  where node.workspace_id=$1 and node.workflow_run_id=$2
                    and node.node_id=$3 and outbox.job_name='execute-node-attempt'
                    and not (outbox.id=any($4::uuid[]))
                    and ($5::int is null or
                      (node.branch_context->'iterationPath'->0->>'ordinal')::int=$5)
                  order by outbox.created_at,outbox.id`,
              [
                workspaceId,
                accepted.runId,
                nodeId,
                attemptOutboxes,
                ordinal ?? null,
              ],
            ),
          (value) => value.length === 1,
        );
        const attempt = rows[0];
        if (attempt === undefined) throw new Error('For Each attempt missing');
        attemptOutboxes.push(attempt.outbox_id);
        const published = await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.node_run_id,
            attemptId: attempt.attempt_id,
            outboxEventId: attempt.outbox_id,
          },
        });
        const result = await waitFor(
          async () => {
            const [nodeRows, job] = await Promise.all([
              workerQuery<{ status: string }>(
                `select status from app.node_runs where workspace_id=$1 and id=$2`,
                [workspaceId, attempt.node_run_id],
              ),
              attemptQueue.getJob(published.jobId),
            ]);
            return {
              failedReason: job?.failedReason,
              state: await job?.getState(),
              status: nodeRows[0]?.status,
            };
          },
          ({ state, status }) => status === 'succeeded' || state === 'failed',
        );
        if (result.status !== 'succeeded')
          throw new Error(
            `For Each attempt failed: ${result.failedReason ?? 'unknown'}`,
          );
        return attempt;
      };
      const executeDuplicateAttempt = async (attempt: {
        attempt_id: string;
        node_run_id: string;
        outbox_id: string;
      }) => {
        const published = await producer.publish({
          name: JOB_NAME.executeNodeAttempt,
          data: {
            schemaVersion: 1,
            workspaceId,
            runId: accepted.runId,
            nodeRunId: attempt.node_run_id,
            attemptId: attempt.attempt_id,
            outboxEventId: attempt.outbox_id,
          },
        });
        const job = await waitFor(
          () => attemptQueue.getJob(published.jobId),
          (value) => value !== undefined,
        );
        if (job === undefined) throw new Error('duplicate attempt disappeared');
        await waitFor(
          () => job.getState(),
          (state) => state === 'completed' || state === 'failed',
        );
        await expect(job.getState()).resolves.toBe('completed');
      };

      await publishCoordinator(accepted.outboxEventId, 1);
      await execute('manual');
      await continueAfter(2);
      const declaration = await execute('for-each');

      const declarationJob = await attemptQueue.getJob(
        `outbox-${declaration.outbox_id}`,
      );
      await declarationJob?.remove();
      await executeDuplicateAttempt(declaration);

      // The declaration outcome is durable before any coordinator consumes it.
      await eraseRedisAndRestart();
      const declarationContinuation = await waitForCoordinatorOutbox(
        accepted.runId,
        coordinatorOutboxes,
      );
      coordinatorOutboxes.push(declarationContinuation);
      await publishCoordinator(declarationContinuation, 3);
      const declarationCoordinatorJob = await coordinatorQueue.getJob(
        `outbox-${declarationContinuation}`,
      );
      await declarationCoordinatorJob?.remove();
      await publishCoordinator(declarationContinuation, 3);
      await eraseRedisAndRestart();

      const reserved = await workerQuery<{
        scheduler_state: unknown;
      }>(
        `select scheduler_state from app.run_checkpoints
            where workspace_id=$1 and workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(reserved[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 997,
        loops: [
          {
            activeOrdinals: [0, 1],
            nextOrdinal: 2,
            terminalOrdinals: [],
          },
        ],
      });

      for (const ordinal of [0, 1]) {
        await execute('body-map', ordinal);
        await continueAfter(4 + ordinal);
      }
      await execute('body-sink', 0);
      await execute('body-sink', 1);

      if (cancelBetweenBatches) {
        await apiDatabase.withWorkspace(workspaceId, (transaction) =>
          requestWorkflowRunCancellation(transaction, {
            actor: 'for-each-recovery-test',
            reason: 'cancel between canonical batches',
            runId: accepted.runId,
          }),
        );
        await eraseRedisAndRestart();
        await continueAfter(6);
        const canceled = await waitFor(
          () =>
            workerQuery<{ scheduler_state: unknown; status: string }>(
              `select run.status,checkpoint.scheduler_state
                   from app.workflow_runs run
                   join app.run_checkpoints checkpoint
                     on checkpoint.workflow_run_id=run.id
                  where run.workspace_id=$1 and run.id=$2`,
              [workspaceId, accepted.runId],
            ),
          (rows) => rows[0]?.status === 'canceled',
        );
        expect(parseCheckpoint(canceled[0]?.scheduler_state)).toMatchObject({
          cancelRequested: true,
          remainingIterationBudget: 997,
          runStatus: 'canceled',
        });
        await expect(
          workerQuery<{ count: string }>(
            `select count(*)::text count from app.node_runs
                where workspace_id=$1 and workflow_run_id=$2
                  and branch_context->'iterationPath' @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb`,
            [workspaceId, accepted.runId],
          ),
        ).resolves.toEqual([{ count: '0' }]);
        return;
      }

      // A sink outcome survives worker/Redis loss before coordinator consumption.
      await eraseRedisAndRestart();
      await continueAfter(6);
      const laterBatch = await workerQuery<{ scheduler_state: unknown }>(
        `select scheduler_state from app.run_checkpoints
            where workspace_id=$1 and workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(laterBatch[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 997,
        loops: [
          {
            activeOrdinals: [2],
            nextOrdinal: 3,
            terminalOrdinals: [0, 1],
          },
        ],
      });
      await eraseRedisAndRestart();
      await execute('body-map', 2);
      await continueAfter(7);
      await execute('body-sink', 2);
      await continueAfter(8);
      await continueAfter(9);
      await execute('outer-successor');
      await continueAfter(10);

      const facts = await workerQuery<{
        branch_context: unknown;
        node_id: string;
        output_ref: unknown;
        scheduler_state: unknown;
        status: string;
      }>(
        `select node.node_id,node.status,node.branch_context,node.output_ref,
                  checkpoint.scheduler_state
             from app.node_runs node
             join app.run_checkpoints checkpoint
               on checkpoint.workflow_run_id=node.workflow_run_id
            where node.workspace_id=$1 and node.workflow_run_id=$2
            order by node.node_id,node.invocation_key`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(facts[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 997,
        runStatus: 'succeeded',
        loops: [
          {
            activeOrdinals: [],
            nextOrdinal: 3,
            terminalOrdinals: [0, 1, 2],
          },
        ],
      });
      expect(
        facts
          .filter(({ node_id }) => node_id === 'body-map')
          .map(({ branch_context, output_ref }) => ({
            branch_context,
            output_ref,
          })),
      ).toEqual(
        [
          { id: 'alpha', value: 11 },
          { id: 'beta', value: 22 },
          { id: 'gamma', value: 33 },
        ].map((item, ordinal) => ({
          branch_context: {
            branchPath: [],
            iterationPath: [{ loopNodeId: 'for-each', ordinal }],
          },
          output_ref: {
            schemaVersion: 1,
            kind: 'inline',
            value: { item, ordinal },
          },
        })),
      );
      expect(
        facts
          .filter(({ node_id }) => node_id === 'body-sink')
          .map(({ output_ref }) => output_ref),
      ).toEqual(
        [
          { id: 'alpha', value: 11 },
          { id: 'beta', value: 22 },
          { id: 'gamma', value: 33 },
        ].map((item, ordinal) => ({
          schemaVersion: 1,
          kind: 'inline',
          value: { result: { item, ordinal } },
        })),
      );
      expect(
        facts.find(({ node_id }) => node_id === 'outer-successor')?.output_ref,
      ).toEqual({
        schemaVersion: 1,
        kind: 'inline',
        value: {
          result: {
            items: [
              { id: 'alpha', value: 11 },
              { id: 'beta', value: 22 },
              { id: 'gamma', value: 33 },
            ],
            iterationCount: 3,
          },
        },
      });
      expect(
        facts.filter(({ node_id }) => node_id === 'for-each'),
      ).toHaveLength(1);
      await expect(
        workerQuery<{ attempts: string; controls: string }>(
          `select
               count(*)::text attempts,
               count(*) filter (where node.node_id='for-each')::text controls
               from app.node_attempts attempt
               join app.node_runs node on node.id=attempt.node_run_id
              where node.workspace_id=$1 and node.workflow_run_id=$2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([{ attempts: '9', controls: '1' }]);
      void declaration;
    };

    try {
      await producer.waitUntilReady(5_000);
      await runFixture(false);
      await runFixture(true);
    } finally {
      await stopWorkers();
      await Promise.allSettled([
        producer.close(),
        coordinatorQueue.close(),
        attemptQueue.close(),
      ]);
    }
  }, 60_000);
});
