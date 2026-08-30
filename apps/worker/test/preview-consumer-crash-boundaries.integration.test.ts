import { randomUUID } from 'node:crypto';

import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database';
import { createQueueProducer, JOB_NAME, parseQueueJob } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { createDatabasePreviewAttemptRunStore } from '../src/execution/preview-attempt-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import { spawnPreviewCrashChild } from './support/preview-consumer-crash-process.support.js';
import {
  acceptDelivery,
  databaseUrl,
  dispatcherUrl,
  previewState,
  previewTerminalFacts,
  providerEffectCount,
  redisUrl,
  validTraceparent,
  waitFor,
  withTenantScopedWorker,
  workerTransportIntegrationEnabled,
  workerUrl,
  workspaceId,
  type AcceptedDelivery,
} from './support/preview-consumer.integration.support.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration('preview dispatch crash boundaries', () => {
  it('preserves the four preview dispatch and acknowledgement crash boundaries', async () => {
    const cases = [
      {
        expectedBarrier: 'preview.before_dispatch_marker_commit',
        expectedDispatch: false,
        expectedProviderCount: 0,
        expectedReconciledStatus: 'queued',
        mode: 'before-dispatch-commit',
      },
      {
        expectedBarrier: 'preview.dispatch_marker_committed_before_provider',
        expectedDispatch: true,
        expectedProviderCount: 0,
        expectedReconciledStatus: 'outcome_unknown',
        mode: 'after-dispatch-before-provider',
      },
      {
        expectedBarrier: 'preview.provider_completed_before_outcome_commit',
        expectedDispatch: true,
        expectedProviderCount: 1,
        expectedReconciledStatus: 'outcome_unknown',
        mode: 'after-provider-before-outcome',
      },
      {
        expectedBarrier: 'preview.outcome_committed_before_queue_ack',
        expectedDispatch: true,
        expectedProviderCount: 1,
        expectedReconciledStatus: 'succeeded',
        mode: 'after-outcome-before-ack',
      },
    ] as const;
    const fixtures: {
      delivery: AcceptedDelivery;
      effectKey: string;
      jobId: string;
      selected: (typeof cases)[number];
    }[] = [];
    const producer = createQueueProducer({ redisUrl });
    const lockRedis = new Redis(redisUrl);
    const queue = new Queue('node-attempts', {
      connection: (() => {
        const parsed = new URL(redisUrl);
        return {
          db: Number(parsed.pathname.slice(1)),
          host: parsed.hostname,
          port: Number(parsed.port || 6379),
          ...(parsed.password === ''
            ? {}
            : { password: decodeURIComponent(parsed.password) }),
        };
      })(),
    });
    await producer.waitUntilReady(5_000);

    try {
      for (const [index, selected] of cases.entries()) {
        const delivery = await acceptDelivery(validTraceparent(index + 40), {
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          sideEffectClass: 'unsafe',
        });
        const effectKey = `preview-process-${selected.mode}-${randomUUID()}`;
        const child = spawnPreviewCrashChild({
          leaseDurationSeconds: 1,
          mode: selected.mode,
          providerEffectKey: effectKey,
          redisUrl,
          workerId: `preview-process-${String(index)}-${randomUUID().slice(0, 8)}`,
          workerUrl: databaseUrl(workerUrl),
          workspaceId,
        });
        await expect(child.evidence).resolves.toMatchObject({
          injectionPoint: 'preview.consumer_ready',
        });
        const job = await producer.publish({
          data: delivery.job.data,
          name: delivery.job.name,
        });
        const evidence = await child.next(
          (message) => message.injectionPoint === selected.expectedBarrier,
        );
        expect(evidence.injectionPoint).toBe(selected.expectedBarrier);
        await expect(queue.getJob(job.jobId)).resolves.not.toBeUndefined();
        await expect(
          queue.getJob(job.jobId).then((published) => published?.getState()),
        ).resolves.toBe('active');

        const atBarrier = await previewState(delivery.accepted.previewRunId);
        expect(atBarrier).toMatchObject({
          attempt_fence: '1',
          attempt_status:
            selected.mode === 'after-outcome-before-ack'
              ? 'succeeded'
              : 'running',
          inbox_completed_count:
            selected.mode === 'after-outcome-before-ack' ? '1' : '0',
          inbox_count: '1',
          run_status:
            selected.mode === 'after-outcome-before-ack'
              ? 'succeeded'
              : 'running',
        });
        expect(
          await previewTerminalFacts(delivery.accepted.previewRunId),
        ).toEqual({
          audit_count: selected.mode === 'after-outcome-before-ack' ? '1' : '0',
          usage_count: selected.mode === 'after-outcome-before-ack' ? '1' : '0',
        });
        expect(atBarrier?.dispatch_marked_at === null).toBe(
          !selected.expectedDispatch,
        );
        expect(await providerEffectCount(effectKey)).toBe(
          selected.expectedProviderCount,
        );
        if (selected.mode === 'after-outcome-before-ack') {
          expect(JSON.parse(String(atBarrier?.output_ref))).toMatchObject({
            value: { executed: true, providerEffectKey: effectKey },
          });
        } else {
          expect(atBarrier?.output_ref).toBeNull();
        }
        expect(await child.kill()).toBe('SIGKILL');
        fixtures.push({ delivery, effectKey, jobId: job.jobId, selected });
      }

      const dispatcher = createOutboxDispatcherDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          ownerRole: 'pertexo_owner',
        }),
      );
      const reconciliationRuntime = await createPreviewMaintenanceRuntime({
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
        }),
        redisUrl,
      });
      try {
        await reconciliationRuntime.consumer.waitUntilReady(5_000);
        await dispatcher.checkReadiness();
        const reconcilable = fixtures.slice(0, 3);
        await waitFor(
          () =>
            Promise.all(
              reconcilable.map(({ delivery }) =>
                previewState(delivery.accepted.previewRunId),
              ),
            ),
          (states) => states.every((state) => state?.lease_expired === true),
        );
        const targetRunIds = new Set(
          reconcilable.map(({ delivery }) => delivery.accepted.previewRunId),
        );
        const selectedEvents = new Map<
          string,
          Awaited<ReturnType<typeof dispatcher.claimBatch>>['events'][number]
        >();
        const events = await waitFor(
          async () => {
            const batch = await dispatcher.claimBatch({
              enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
              leaseDurationMillis: 5_000,
              leaseOwner: 'preview-process-crash-matrix',
              leaseToken: randomUUID(),
              limit: 20,
              maxAttempts: 3,
            });
            for (const event of batch.events) {
              if (targetRunIds.has(event.aggregateId))
                selectedEvents.set(event.id, event);
            }
            return [...selectedEvents.values()];
          },
          (value) => value.length === reconcilable.length,
        );
        await Promise.all(
          events.map(async (event) => {
            const job = parseQueueJob({
              name: event.jobName,
              data: event.payload,
            });
            if (job.name !== JOB_NAME.reconcilePreviewAttempt)
              throw new Error('claimed preview reconciliation job mismatch');
            await producer.publish(job);
            await dispatcher.markPublished(event.id, event.leaseToken);
          }),
        );

        const reconciled = await waitFor(
          () =>
            Promise.all(
              reconcilable.map(({ delivery }) =>
                previewState(delivery.accepted.previewRunId),
              ),
            ),
          (states) =>
            states.every(
              (state, index) =>
                state?.run_status ===
                reconcilable[index]?.selected.expectedReconciledStatus,
            ),
        );
        expect(reconciled.map((state) => state?.run_status)).toEqual([
          'queued',
          'outcome_unknown',
          'outcome_unknown',
        ]);
        expect(reconciled.map((state) => state?.attempt_fence)).toEqual([
          '2',
          '2',
          '2',
        ]);
        expect(
          await Promise.all(
            reconcilable.map(({ delivery }) =>
              previewTerminalFacts(delivery.accepted.previewRunId),
            ),
          ),
        ).toEqual([
          { audit_count: '0', usage_count: '0' },
          { audit_count: '1', usage_count: '1' },
          { audit_count: '1', usage_count: '1' },
        ]);
        expect(reconciled.map((state) => state?.inbox_count)).toEqual([
          '1',
          '1',
          '1',
        ]);
        expect(
          await Promise.all(
            reconcilable.map(({ effectKey }) => providerEffectCount(effectKey)),
          ),
        ).toEqual([0, 0, 1]);
        const reconciliationReceipts = await withTenantScopedWorker((client) =>
          client.query<{ completed: string; count: string }>(
            `select count(*)::text as count,
                    count(completed_at)::text as completed
               from app.inbox_receipts
              where consumer_name='preview-attempt-reconciler'
                and message_id=any($1::uuid[])`,
            [events.map((event) => event.id)],
          ),
        );
        expect(reconciliationReceipts.rows[0]).toEqual({
          completed: String(reconcilable.length),
          count: String(reconcilable.length),
        });

        for (const fixture of reconcilable) {
          const crashedJob = await queue.getJob(fixture.jobId);
          if (crashedJob === undefined)
            throw new Error('crashed preview job is missing');
          await lockRedis.del(`${queue.toKey(fixture.jobId)}:lock`);
          await crashedJob.remove();
        }

        const terminal = fixtures[3];
        if (terminal === undefined) throw new Error('terminal fixture missing');
        const beforeRedelivery = await previewState(
          terminal.delivery.accepted.previewRunId,
        );
        const beforeFacts = await previewTerminalFacts(
          terminal.delivery.accepted.previewRunId,
        );
        await lockRedis.del(`${queue.toKey(terminal.jobId)}:lock`);
        await lockRedis.sadd(queue.toKey('stalled'), terminal.jobId);
        const redeliveryStore = createDatabasePreviewAttemptRunStore(
          parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
        );
        const redeliveryRuntime = await createNodeAttemptRuntime({
          database: parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
          }),
          heartbeatIntervalMillis: 200,
          leaseDurationSeconds: 10,
          preview: {
            invoker: {
              invoke: () => {
                throw new Error('terminal preview redelivery invoked provider');
              },
            },
            runStore: redeliveryStore,
          },
          redisUrl,
          releaseCohort: 'core',
          workerId: `preview-redelivery-${randomUUID().slice(0, 8)}`,
        });
        try {
          await redeliveryRuntime.consumer.waitUntilReady(5_000);
          await waitFor(
            () =>
              queue
                .getJob(terminal.jobId)
                .then((job) => job?.getState() ?? 'missing'),
            (state) => state === 'completed',
            75_000,
          );
        } finally {
          await redeliveryRuntime.close();
        }
        expect(await providerEffectCount(terminal.effectKey)).toBe(1);
        await expect(
          previewState(terminal.delivery.accepted.previewRunId),
        ).resolves.toEqual(beforeRedelivery);
        await expect(
          previewTerminalFacts(terminal.delivery.accepted.previewRunId),
        ).resolves.toEqual(beforeFacts);
      } finally {
        await Promise.allSettled([
          reconciliationRuntime.close(),
          dispatcher.close(),
        ]);
      }
    } finally {
      await Promise.allSettled([
        producer.close(),
        queue.close(),
        lockRedis.quit(),
      ]);
      lockRedis.disconnect();
    }
  }, 90_000);
});
