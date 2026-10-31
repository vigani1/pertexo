import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { EXPECTED_MIGRATION_HEAD } from '@pertexo/database/testing';
import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  parseQueueJob,
  QUEUE_NAME,
} from '@pertexo/queue';
import type { QueueConsumer, QueueProducer } from '@pertexo/queue';
import { Queue } from 'bullmq';

import { expect, it } from 'vitest';
import { z } from 'zod';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import type { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';

import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import {
  REDIS_PROOF_DATABASE,
  type ProofMeasurements,
  redisNamespace,
  redisUrl,
  redisConnection,
  createProofDatabase,
  dropProofDatabase,
  restoreServices,
  stopProofService,
  startProofService,
  flushProofRedis,
  withDeadline,
  insertProofEvent,
  outboxState,
  assertCleanOutbox,
  createDispatcher,
  waitForJob,
  dependencyEvidence,
} from './fixture.js';

export function registerRecoversPostgreSQLAuthorityAcrossRedisQueue(): void {
  it('recovers PostgreSQL authority across Redis, queue, and PostgreSQL loss while draining safely', async () => {
    const workspaceId = randomUUID();
    const queueLossEventId = randomUUID();
    const redisLossEventId = randomUUID();
    const postgresLossEventId = randomUUID();
    const drainEventId = randomUUID();
    const consumerEventId = randomUUID();
    const measurements: ProofMeasurements = {};
    let queue: Queue | undefined;
    let redisDispatcher: OutboxDispatcher | undefined;
    let postgresDispatcher: OutboxDispatcher | undefined;
    let drainedDispatcher: OutboxDispatcher | undefined;
    let consumer: QueueConsumer | undefined;
    let consumerProducer: QueueProducer | undefined;
    let redisNamespaceAcquired = false;
    let proofCompleted = false;

    await runWithCleanup(
      async () => {
        await redisNamespace.acquire();
        redisNamespaceAcquired = true;
        await createProofDatabase();
        await flushProofRedis();
        await assertCleanOutbox(workspaceId);
        await dependencyEvidence(measurements);
        expect(measurements.migrationHead).toBe(EXPECTED_MIGRATION_HEAD);

        queue = new Queue(QUEUE_NAME.maintenance, {
          connection: redisConnection(),
        });
        await queue.waitUntilReady();

        const redisBoundaries = createDispatcher(
          new WorkerDrainState(),
          'resilience-redis',
        );
        redisDispatcher = redisBoundaries.dispatcher;
        await redisDispatcher.checkReadiness();

        // Failure point: enqueue succeeds, the dispatcher has not marked the
        // PostgreSQL outbox row, and every Redis key is then lost.
        await insertProofEvent(workspaceId, queueLossEventId);
        const claimed = await redisBoundaries.database.claimBatch({
          enabledJobNames: [JOB_NAME.deliverRunFailureNotification],
          leaseDurationMillis: 1_000,
          leaseOwner: 'resilience-crashed',
          leaseToken: randomUUID(),
          limit: 1,
        });
        expect(claimed.events).toHaveLength(1);
        const leased = claimed.events[0];
        if (leased === undefined) throw new Error('Outbox claim disappeared');
        await redisBoundaries.producer.publish(
          parseQueueJob({
            name: leased.jobName,
            data: {
              ...(typeof leased.payload === 'object' &&
              leased.payload !== null &&
              !Array.isArray(leased.payload)
                ? leased.payload
                : {}),
              outboxEventId: leased.id,
              workspaceId: leased.workspaceId,
            },
          }),
        );
        await waitForJob(queue, queueLossEventId);
        await flushProofRedis();
        expect(
          await queue.getJob(`outbox-${queueLossEventId}`),
        ).toBeUndefined();

        const queueRecoveryStartedAt = performance.now();
        // Measure recovery after the real PostgreSQL outbox lease expires while
        // Redis has lost the corresponding queue job.
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
        await redisDispatcher.dispatchOnce();
        await waitForJob(queue, queueLossEventId);
        measurements.queueLossRecoveryMs =
          performance.now() - queueRecoveryStartedAt;
        const queueRecovered = await outboxState(queueLossEventId);
        measurements.queueLossRecoveredPublishAttempts =
          queueRecovered.publish_attempts;
        expect(queueRecovered.publish_attempts).toBe(2);
        expect(queueRecovered.published_at).toBeInstanceOf(Date);

        // Failure point: Redis is fully stopped while a durable outbox row is
        // waiting. Publishing fails closed and releases the PostgreSQL lease.
        await insertProofEvent(workspaceId, redisLossEventId);
        const stoppedRedis = await stopProofService('redis');
        const redisDetectionStartedAt = performance.now();
        await expect(redisDispatcher.checkReadiness()).rejects.toThrow();
        measurements.redisFailureDetectionMs =
          performance.now() - redisDetectionStartedAt;
        await expect(redisDispatcher.dispatchOnce()).resolves.toEqual({
          claimed: 1,
          failed: 1,
          outcomeUnknown: 0,
          published: 0,
          stale: 0,
        });
        const redisUnavailable = await outboxState(redisLossEventId);
        measurements.redisUnavailableBacklog =
          redisUnavailable.published_at === null &&
          redisUnavailable.failed_at === null
            ? 1
            : 0;
        measurements.redisUnavailableLeaseReleased =
          redisUnavailable.lease_owner === null &&
          redisUnavailable.lease_expires_at === null;
        measurements.redisUnavailablePublishAttempts =
          redisUnavailable.publish_attempts;
        expect(redisUnavailable).toMatchObject({
          failed_at: null,
          last_error_code: 'queue.publish_failed',
          lease_expires_at: null,
          lease_owner: null,
          publish_attempts: 1,
          published_at: null,
        });

        const redisRecoveryStartedAt = performance.now();
        await startProofService(stoppedRedis);
        await withDeadline(
          redisDispatcher.checkReadiness(),
          'Redis readiness recovery',
        );
        await waitForJob(queue, queueLossEventId);
        measurements.redisRestartRetainedJobs = 1;
        await redisDispatcher.dispatchOnce();
        await waitForJob(queue, redisLossEventId);
        measurements.redisRecoveryMs =
          performance.now() - redisRecoveryStartedAt;
        const redisRecovered = await outboxState(redisLossEventId);
        measurements.redisRecoveredPublishAttempts =
          redisRecovered.publish_attempts;
        expect(redisRecovered.publish_attempts).toBe(2);
        expect(redisRecovered.published_at).toBeInstanceOf(Date);

        await redisDispatcher.close();
        redisDispatcher = undefined;
        await queue.close();
        queue = undefined;
        await flushProofRedis();

        // Create the authority record while PostgreSQL is healthy, close its
        // serving connection, then start a dispatcher while PostgreSQL is down.
        await insertProofEvent(workspaceId, postgresLossEventId);
        const stoppedPostgres = await stopProofService('postgres');
        const postgresBoundaries = createDispatcher(
          new WorkerDrainState(),
          'resilience-postgres',
        );
        postgresDispatcher = postgresBoundaries.dispatcher;
        const postgresDetectionStartedAt = performance.now();
        await expect(postgresDispatcher.checkReadiness()).rejects.toThrow();
        measurements.postgresFailureDetectionMs =
          performance.now() - postgresDetectionStartedAt;
        await expect(postgresDispatcher.dispatchOnce()).rejects.toThrow();

        queue = new Queue(QUEUE_NAME.maintenance, {
          connection: redisConnection(),
        });
        await queue.waitUntilReady();
        expect(
          await queue.getJob(`outbox-${postgresLossEventId}`),
        ).toBeUndefined();

        const postgresRecoveryStartedAt = performance.now();
        await startProofService(stoppedPostgres);
        await withDeadline(
          postgresDispatcher.checkReadiness(),
          'PostgreSQL readiness recovery',
        );
        await postgresDispatcher.dispatchOnce();
        await waitForJob(queue, postgresLossEventId);
        measurements.postgresRecoveryMs =
          performance.now() - postgresRecoveryStartedAt;
        const postgresRecovered = await outboxState(postgresLossEventId);
        measurements.postgresRecoveredPublishAttempts =
          postgresRecovered.publish_attempts;
        expect(postgresRecovered.publish_attempts).toBe(1);
        expect(postgresRecovered.published_at).toBeInstanceOf(Date);

        await postgresDispatcher.close();
        postgresDispatcher = undefined;
        await queue.close();
        queue = undefined;
        await flushProofRedis();

        // Real drain proof: readiness falls before drain, dispatch admits no
        // row, and both dispatcher and an active consumer close within bounds.
        await insertProofEvent(workspaceId, drainEventId);
        const drainState = new WorkerDrainState();
        const drainBoundaries = createDispatcher(
          drainState,
          'resilience-drain',
        );
        drainedDispatcher = drainBoundaries.dispatcher;
        await drainedDispatcher.checkReadiness();
        drainState.beginDrain();
        await expect(drainedDispatcher.checkReadiness()).rejects.toThrow(
          /draining/u,
        );
        await expect(drainedDispatcher.dispatchOnce()).resolves.toEqual({
          claimed: 0,
          failed: 0,
          outcomeUnknown: 0,
          published: 0,
          stale: 0,
        });
        const drainedOutbox = await outboxState(drainEventId);
        measurements.drainNoNewClaimAttempts = drainedOutbox.publish_attempts;
        expect(drainedOutbox).toMatchObject({
          lease_owner: null,
          publish_attempts: 0,
          published_at: null,
        });
        const drainCloseStartedAt = performance.now();
        await drainedDispatcher.close();
        measurements.drainCloseMs = performance.now() - drainCloseStartedAt;
        expect(measurements.drainCloseMs).toBeLessThan(2_000);
        drainedDispatcher = undefined;

        const handlerStarted = (() => {
          let resolveStarted: (() => void) | undefined;
          const promise = new Promise<void>((resolve) => {
            resolveStarted = resolve;
          });
          return {
            promise,
            resolve: (): void => resolveStarted?.(),
          };
        })();
        consumer = createQueueConsumer({
          drainTimeoutMs: 50,
          handler: async (_delivery, context) => {
            handlerStarted.resolve();
            await new Promise<never>((_resolve, reject) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  reject(
                    context.signal.reason instanceof Error
                      ? context.signal.reason
                      : new Error('Consumer proof aborted'),
                  );
                },
                { once: true },
              );
            });
          },
          queueName: QUEUE_NAME.workflowCoordinator,
          redisUrl,
          timeoutMs: 5_000,
        });
        consumerProducer = createQueueProducer({ redisUrl });
        await Promise.all([
          consumer.waitUntilReady(),
          consumerProducer.waitUntilReady(),
        ]);
        const consumerRunId = randomUUID();
        await consumerProducer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            outboxEventId: consumerEventId,
            runId: consumerRunId,
            workspaceId,
          },
        });
        await withDeadline(handlerStarted.promise, 'consumer admission');
        const consumerCloseStartedAt = performance.now();
        const closeResult = await consumer.close();
        measurements.forcedConsumerCloseMs =
          performance.now() - consumerCloseStartedAt;
        expect(closeResult).toEqual({ abortedJobs: 1, forced: true });
        expect(consumer.isReady()).toBe(false);
        expect(measurements.forcedConsumerCloseMs).toBeLessThan(2_000);
        consumer = undefined;

        // Qualify the BullMQ release the queue package actually ships.
        const queuePackage = z
          .object({ dependencies: z.object({ bullmq: z.string().min(1) }) })
          .parse(
            JSON.parse(
              await readFile(
                new URL(
                  '../../../../../packages/queue/package.json',
                  import.meta.url,
                ),
                'utf8',
              ),
            ),
          );
        expect(measurements).toMatchObject({
          bullmqVersion: queuePackage.dependencies.bullmq,
          migrationHead: EXPECTED_MIGRATION_HEAD,
        });
        proofCompleted = true;
      },
      async () => {
        const errors: unknown[] = [];
        const attempt = async (
          label: string,
          operation: () => unknown,
        ): Promise<void> => {
          await Promise.resolve()
            .then(operation)
            .catch((cause: unknown) => {
              errors.push(
                new Error(`Transport resilience cleanup failed: ${label}`, {
                  cause,
                }),
              );
            });
        };
        await attempt('restore Compose services', restoreServices);
        await attempt('Redis dispatcher', () => redisDispatcher?.close());
        await attempt('PostgreSQL dispatcher', () =>
          postgresDispatcher?.close(),
        );
        await attempt('drained dispatcher', () => drainedDispatcher?.close());
        await attempt('consumer', () => consumer?.close());
        await attempt('consumer producer', () => consumerProducer?.close());
        await attempt('inspection queue', () => queue?.close());
        if (redisNamespaceAcquired) {
          await attempt('flush private Redis database', flushProofRedis);
          await attempt('release Redis namespace', () =>
            redisNamespace.close(),
          );
        }
        await attempt('drop disposable database', dropProofDatabase);
        process.stdout.write(
          `PHASE_0D_RESILIENCE_METRICS ${JSON.stringify({
            ...measurements,
            qualificationStatus: proofCompleted ? 'completed' : 'failed',
            failureInjectionPoints: [
              'enqueue-before-outbox-mark then Redis DB loss',
              'Redis service stop before outbox dispatch',
              'PostgreSQL service stop before outbox claim',
              'drain before dispatcher claim',
              'drain deadline during active BullMQ handler',
            ],
            redisDatabase: REDIS_PROOF_DATABASE,
          })}\n`,
        );
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Transport resilience cleanup failed',
          );
      },
      'Transport resilience proof',
    );
  });
}
