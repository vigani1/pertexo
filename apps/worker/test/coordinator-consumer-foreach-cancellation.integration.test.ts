import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createDeadlineWakeupScanner,
  createNodeAttemptRunStore,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { parseCheckpoint } from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { coordinatorFixture } from './coordinator-consumer.fixtures.js';
import {
  acceptForEachRun,
  cancelFixtureRun,
  waitForCoordinatorOutbox,
} from './support/coordinator-run-fixtures.js';

const {
  databaseUrl,
  enabled,
  ownerQuery,
  redisConnection,
  redisUrl,
  restoreServicesAndClose,
  setup,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} = coordinatorFixture;
const describeIntegration = enabled ? describe : describe.skip;
const MAXIMUM_CHILD_OUTPUT_BYTES = 64 * 1_024;

type ChildExit = Readonly<{
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
}>;

type OwnedChild = Readonly<{
  child: ChildProcess;
  exit: Promise<ChildExit>;
}>;

async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopOwnedChild(owner: OwnedChild): Promise<void> {
  if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
    const exited = await owner.exit;
    if (exited.error !== undefined) throw exited.error;
    return;
  }
  if (!owner.child.kill('SIGTERM'))
    throw new Error('For Each child rejected SIGTERM');
  try {
    const exited = await bounded(
      owner.exit,
      5_000,
      'For Each child ignored SIGTERM',
    );
    if (exited.error !== undefined) throw exited.error;
    if (exited.code !== 0)
      throw new Error(
        `For Each child stopped unsuccessfully (${String(exited.code)}, ${String(exited.signal)})`,
      );
  } catch (gracefulError: unknown) {
    if (childIsRunning(owner.child) && !owner.child.kill('SIGKILL'))
      throw new AggregateError(
        [gracefulError, new Error('For Each child rejected SIGKILL')],
        'For Each child termination failed',
      );
    const forcedExit = await bounded(
      owner.exit,
      5_000,
      'For Each child did not exit after SIGKILL',
    );
    if (forcedExit.error !== undefined)
      throw new AggregateError(
        [gracefulError, forcedExit.error],
        'For Each child termination failed',
      );
    throw gracefulError;
  }
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

describeIntegration('For Each cancellation recovery', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);

  it('recovers bounded For Each batches and cancellation from PostgreSQL on fresh workers', async () => {
    let producer: ReturnType<typeof createQueueProducer> | undefined;
    let coordinatorQueue: Queue | undefined;
    let attemptQueue: Queue | undefined;
    let workers: OwnedChild | undefined;
    try {
      producer = createQueueProducer({ redisUrl });
      coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
        connection: redisConnection(),
      });
      const ownedProducer = producer;
      const ownedCoordinatorQueue = coordinatorQueue;
      const ownedAttemptQueue = attemptQueue;
      const startWorkers = async (): Promise<OwnedChild> => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('./for-each-worker-process-fixture.ts', import.meta.url),
            ),
          ],
          {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            env: {
              ...process.env,
              FOR_EACH_DATABASE_URL: databaseUrl(workerUrl),
              FOR_EACH_REDIS_URL: redisUrl,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const exit = new Promise<ChildExit>((resolve) => {
          let settled = false;
          const settle = (result: ChildExit): void => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          child.once('error', (error) => {
            settle({ code: null, error, signal: null });
          });
          child.once('exit', (code, signal) => {
            settle({ code, signal });
          });
        });
        const owner = Object.freeze({ child, exit });
        let stdout = '';
        let pendingLine = '';
        let stderr = '';
        let ready = false;
        const readiness = new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            settle(new Error(`For Each child startup timed out: ${stderr}`));
          }, 10_000);
          timer.unref();
          const settle = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error === undefined) resolve();
            else reject(error);
          };
          child.stdout.on('data', (chunk: Buffer) => {
            stdout = (stdout + chunk.toString()).slice(
              -MAXIMUM_CHILD_OUTPUT_BYTES,
            );
            pendingLine += chunk.toString();
            if (Buffer.byteLength(pendingLine) > MAXIMUM_CHILD_OUTPUT_BYTES) {
              settle(new Error('For Each child stdout frame is too large'));
              return;
            }
            const lines = pendingLine.split('\n');
            pendingLine = lines.pop() ?? '';
            for (const line of lines) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                continue;
              }
              if (
                typeof parsed === 'object' &&
                parsed !== null &&
                (parsed as { ready?: unknown }).ready === true &&
                (parsed as { pid?: unknown }).pid === child.pid
              ) {
                ready = true;
                settle();
              }
            }
          });
          child.stderr.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(
              -MAXIMUM_CHILD_OUTPUT_BYTES,
            );
          });
          void exit.then((result) => {
            if (!ready)
              settle(
                result.error ??
                  new Error(
                    `For Each child exited during startup (${String(result.code)}, ${String(result.signal)}): ${stderr}`,
                  ),
              );
          });
        });
        try {
          await readiness;
          return owner;
        } catch (startupError: unknown) {
          let cleanupError: unknown;
          await stopOwnedChild(owner).catch((error: unknown) => {
            cleanupError = error;
          });
          if (cleanupError === undefined) throw startupError;
          throw new AggregateError(
            [startupError, cleanupError],
            'For Each child startup failed',
          );
        }
      };
      workers = await startWorkers();
      const stopWorkers = async () => {
        const activeWorkers = workers;
        if (activeWorkers === undefined) return;
        await stopOwnedChild(activeWorkers);
        workers = undefined;
      };
      const eraseRedisAndRestart = async () => {
        await stopWorkers();
        await Promise.all([
          ownedCoordinatorQueue.obliterate({ force: true }),
          ownedAttemptQueue.obliterate({ force: true }),
        ]);
        workers = await startWorkers();
      };

      const runFixture = async (
        mode:
          | 'complete'
          | 'cancel_between_batches'
          | 'cancel_running'
          | 'deadline_running',
      ) => {
        const accepted = await acceptForEachRun();
        const coordinatorOutboxes = [accepted.outboxEventId];
        const attemptOutboxes: string[] = [];
        const publishCoordinator = async (
          outboxEventId: string,
          expectedRevision: number,
        ) => {
          const published = await ownedProducer.publish({
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
                ownedCoordinatorQueue.getJob(published.jobId),
              ]);
              return {
                failedReason: job?.failedReason,
                stacktrace: job?.stacktrace,
                revision: rows[0]?.revision,
                state: await job?.getState(),
              };
            },
            ({ revision, state }) =>
              state === 'failed' ||
              (revision === expectedRevision &&
                (state === undefined || state === 'completed')),
          );
          if (result.state === 'failed' || result.revision !== expectedRevision)
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
        const findAttempt = async (nodeId: string, ordinal?: number) => {
          const rows = await waitFor(
            () =>
              workerQuery<{
                attempt_id: string;
                node_run_id: string;
                outbox_id: string;
                payload_checksum: string;
              }>(
                `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id,
                        outbox.payload_checksum
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
          if (attempt === undefined)
            throw new Error('For Each attempt missing');
          attemptOutboxes.push(attempt.outbox_id);
          return attempt;
        };
        const execute = async (nodeId: string, ordinal?: number) => {
          const attempt = await findAttempt(nodeId, ordinal);
          const published = await ownedProducer.publish({
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
                ownedAttemptQueue.getJob(published.jobId),
              ]);
              return {
                failedReason: job?.failedReason,
                state: await job?.getState(),
                status: nodeRows[0]?.status,
              };
            },
            ({ state, status }) =>
              state === 'failed' ||
              (status === 'succeeded' &&
                (state === undefined || state === 'completed')),
          );
          if (result.state === 'failed' || result.status !== 'succeeded')
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
          const published = await ownedProducer.publish({
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
            () => ownedAttemptQueue.getJob(published.jobId),
            (value) => value !== undefined,
          );
          if (job === undefined)
            throw new Error('duplicate attempt disappeared');
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

        const declarationJob = await ownedAttemptQueue.getJob(
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
        const declarationCoordinatorJob = await ownedCoordinatorQueue.getJob(
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

        if (mode !== 'cancel_running' && mode !== 'deadline_running') {
          for (const ordinal of [0, 1]) {
            await execute('body-map', ordinal);
            await continueAfter(4 + ordinal);
          }
          await execute('body-sink', 0);
          await execute('body-sink', 1);
        }

        if (mode === 'cancel_between_batches') {
          await cancelFixtureRun(
            accepted.runId,
            'cancel between canonical batches',
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

        if (mode === 'cancel_running' || mode === 'deadline_running') {
          const attempts = await Promise.all(
            [0, 1].map((ordinal) => findAttempt('body-map', ordinal)),
          );
          const store = createNodeAttemptRunStore(
            parseDatabaseConfig({
              connectionString: databaseUrl(workerUrl),
              max: 2,
            }),
          );
          try {
            const claimed = await Promise.all(
              attempts.map(async (attempt, ordinal) => {
                const result = await store.claimDelivery({
                  workspaceId,
                  runId: accepted.runId,
                  nodeRunId: attempt.node_run_id,
                  attemptId: attempt.attempt_id,
                  delivery: {
                    outboxEventId: attempt.outbox_id,
                    payloadChecksum: attempt.payload_checksum,
                  },
                  leaseDurationSeconds: 30,
                  workerId: `for-each-${mode}-${String(ordinal)}`,
                  signal: new AbortController().signal,
                });
                if (result.kind !== 'claimed')
                  throw new Error(
                    `For Each attempt was not claimed: ${result.kind}`,
                  );
                return result;
              }),
            );
            const firstClaim = claimed[0];
            const secondClaim = claimed[1];
            if (firstClaim === undefined || secondClaim === undefined)
              throw new Error('For Each running claims are incomplete');

            if (mode === 'cancel_running') {
              await cancelFixtureRun(
                accepted.runId,
                'cancel while canonical body attempt is running',
              );
            } else {
              await ownerQuery(
                `update app.workflow_runs
                    set deadline_at=clock_timestamp()-interval '1 second',
                        deadline_wakeup_at=null,
                        updated_at=clock_timestamp()
                  where workspace_id=$1 and id=$2`,
                [workspaceId, accepted.runId],
              );
              const scanner = createDeadlineWakeupScanner(
                parseDatabaseConfig({
                  connectionString: databaseUrl(workerUrl),
                  max: 1,
                }),
              );
              try {
                await expect(scanner.claimDueWakeups(10)).resolves.toBe(1);
              } finally {
                await scanner.close();
              }
            }

            await eraseRedisAndRestart();
            await continueAfter(4);
            const stopped = await workerQuery<{
              scheduler_state: unknown;
              node_id: string;
              status: string;
            }>(
              `select node.node_id,node.status,checkpoint.scheduler_state
                 from app.node_runs node
                 join app.run_checkpoints checkpoint
                   on checkpoint.workflow_run_id=node.workflow_run_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.node_id='body-map'
                order by (node.branch_context->'iterationPath'->0->>'ordinal')::int`,
              [workspaceId, accepted.runId],
            );
            expect(stopped.map(({ status }) => status)).toEqual([
              'running',
              'running',
            ]);
            expect(parseCheckpoint(stopped[0]?.scheduler_state)).toMatchObject({
              cancelRequested: mode === 'cancel_running',
              deadlineExpired: mode === 'deadline_running',
              remainingIterationBudget: 997,
              runStatus: 'running',
              loops: [
                {
                  activeOrdinals: [0, 1],
                  nextOrdinal: 2,
                  terminalOrdinals: [],
                },
              ],
            });
            await expect(
              workerQuery<{ attempts: string; new_work: string }>(
                `select
                   count(*)::text attempts,
                   count(*) filter (
                     where node.node_id='body-sink'
                        or node.branch_context->'iterationPath'
                           @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb
                   )::text new_work
                   from app.node_attempts attempt
                   join app.node_runs node on node.id=attempt.node_run_id
                  where node.workspace_id=$1 and node.workflow_run_id=$2`,
                [workspaceId, accepted.runId],
              ),
            ).resolves.toEqual([{ attempts: '4', new_work: '0' }]);

            const firstCompletion = await store.complete({
              lease: firstClaim.lease,
              outcome: {
                status: 'succeeded',
                output: {
                  item: { id: 'alpha', value: 11 },
                  ordinal: 0,
                },
              },
              signal: new AbortController().signal,
            });
            expect(firstCompletion.kind).toBe('committed');
            await continueAfter(5);
            const secondCompletion = await store.complete({
              lease: secondClaim.lease,
              outcome:
                mode === 'cancel_running'
                  ? {
                      status: 'canceled',
                      safeErrorCode: 'execution.canceled',
                    }
                  : {
                      status: 'outcome_unknown',
                      safeErrorCode: 'execution.outcome_unknown',
                    },
              signal: new AbortController().signal,
            });
            expect(secondCompletion.kind).toBe('committed');
            await continueAfter(6);
            const terminal = await workerQuery<{
              scheduler_state: unknown;
              status: string;
            }>(
              `select run.status,checkpoint.scheduler_state
                 from app.workflow_runs run
                 join app.run_checkpoints checkpoint
                   on checkpoint.workflow_run_id=run.id
                where run.workspace_id=$1 and run.id=$2`,
              [workspaceId, accepted.runId],
            );
            expect(terminal[0]?.status).toBe(
              mode === 'cancel_running' ? 'canceled' : 'outcome_unknown',
            );
            expect(parseCheckpoint(terminal[0]?.scheduler_state)).toMatchObject(
              {
                remainingIterationBudget: 997,
                runStatus:
                  mode === 'cancel_running' ? 'canceled' : 'outcome_unknown',
                loops: [
                  {
                    activeOrdinals: [],
                    nextOrdinal: 2,
                    terminalOrdinals: [0, 1],
                  },
                ],
              },
            );
            await expect(
              workerQuery<{ attempts: string; new_work: string }>(
                `select
                   count(*)::text attempts,
                   count(*) filter (
                     where node.node_id='body-sink'
                        or node.branch_context->'iterationPath'
                           @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb
                   )::text new_work
                   from app.node_attempts attempt
                   join app.node_runs node on node.id=attempt.node_run_id
                  where node.workspace_id=$1 and node.workflow_run_id=$2`,
                [workspaceId, accepted.runId],
              ),
            ).resolves.toEqual([{ attempts: '4', new_work: '0' }]);
          } finally {
            await store.close();
          }
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
          facts.find(({ node_id }) => node_id === 'outer-successor')
            ?.output_ref,
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
      };

      await ownedProducer.waitUntilReady(5_000);
      await runFixture('complete');
      await runFixture('cancel_between_batches');
      await runFixture('cancel_running');
      await runFixture('deadline_running');
    } finally {
      const errors: unknown[] = [];
      const activeWorkers = workers;
      if (activeWorkers !== undefined)
        await stopOwnedChild(activeWorkers).catch((error: unknown) =>
          errors.push(error),
        );
      await producer?.close().catch((error: unknown) => errors.push(error));
      await coordinatorQueue
        ?.close()
        .catch((error: unknown) => errors.push(error));
      await attemptQueue?.close().catch((error: unknown) => errors.push(error));
      if (errors.length > 0)
        // Cleanup failures must remain visible even when the scenario failed.
        // eslint-disable-next-line no-unsafe-finally
        throw new AggregateError(
          errors,
          'For Each recovery scenario cleanup failed',
        );
    }
  }, 120_000);
});
