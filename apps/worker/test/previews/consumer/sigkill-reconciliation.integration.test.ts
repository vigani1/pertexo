import { maintenanceConfig } from '../../../../../infrastructure/testing/worker-databases.mjs';
import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import {
  createQueueProducer,
  JOB_NAME,
  parseQueueJob,
} from '@pertexo/queue/server';
import { describe, expect, it } from 'vitest';

import { createMaintenanceRuntime } from '../../../src/maintenance/maintenance.runtime.js';
import { spawnPreviewCrashChild } from '../../support/previews/crash-process.js';
import {
  acceptanceInput,
  databaseUrl,
  dispatcherUrl,
  previewState,
  redisUrl,
  validTraceparent,
  waitFor,
  withTenantAccept,
  withTenantScopedWorker,
  workerTransportIntegrationEnabled,
  workerUrl,
  workspaceId,
} from '../../support/previews/consumer.js';
import { runWithCleanup } from '../../support/infrastructure/test-operation.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

const cases = [
  {
    complete: false,
    expectedStatus: 'queued',
    injectionPoint: 'preview.claim_committed_before_process_exit',
    fence: 2,
    markDispatched: false,
    overrides: {
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      sideEffectClass: 'unsafe' as const,
    },
  },
  {
    complete: false,
    expectedStatus: 'queued',
    injectionPoint: 'preview.dispatch_marker_committed_before_process_exit',
    fence: 2,
    markDispatched: true,
    overrides: {
      mayContactProvider: true,
      mayCauseExternalSideEffect: false,
      sideEffectClass: 'safe' as const,
    },
  },
  {
    complete: false,
    expectedStatus: 'queued',
    injectionPoint: 'preview.dispatch_marker_committed_before_process_exit',
    fence: 2,
    markDispatched: true,
    overrides: {
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      providerIdempotencyKey: `preview-sigkill-${randomUUID()}`,
      sideEffectClass: 'idempotent_with_key' as const,
    },
  },
  {
    complete: false,
    expectedStatus: 'outcome_unknown',
    injectionPoint: 'preview.dispatch_marker_committed_before_process_exit',
    fence: 2,
    markDispatched: true,
    overrides: {
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      sideEffectClass: 'unsafe' as const,
    },
  },
  {
    complete: true,
    expectedStatus: 'failed',
    injectionPoint: 'preview.outcome_committed_before_process_exit',
    fence: 1,
    markDispatched: false,
    overrides: {
      mayCauseExternalSideEffect: false,
      sideEffectClass: 'safe' as const,
    },
  },
] as const;

describeIntegration('preview SIGKILL reconciliation', () => {
  for (const [index, selected] of cases.entries()) {
    it(`preserves durable reconciliation decisions after lease-owner SIGKILL (case ${String(index + 1)})`, async ({
      signal,
      onTestFinished,
    }) => {
      const operation = verifyReconciliationAfterCrash(selected, signal);
      // A timed-out test body keeps running; join its cleanup before the fixture releases Redis.
      onTestFinished(async () => {
        if (signal.aborted) await operation;
      });
      await operation;
    });
  }
});

async function verifyReconciliationAfterCrash(
  selected: (typeof cases)[number],
  signal: AbortSignal,
): Promise<void> {
  const accepted = await withTenantAccept(
    acceptanceInput(validTraceparent, selected.overrides),
  );
  signal.throwIfAborted();
  const payload = {
    workspaceId,
    outboxEventId: accepted.outboxEventId,
    previewRunId: accepted.previewRunId,
    previewAttemptId: accepted.previewAttemptId,
    traceparent: validTraceparent,
  };
  const workerId = `preview-sigkill-${randomUUID().slice(0, 8)}`;
  const child = spawnPreviewCrashChild({
    complete: selected.complete,
    delivery: {
      outboxEventId: accepted.outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    },
    leaseDurationSeconds: 1,
    markDispatched: selected.markDispatched,
    previewAttemptId: accepted.previewAttemptId,
    previewRunId: accepted.previewRunId,
    redisUrl,
    workerId,
    workerUrl: databaseUrl(workerUrl),
    workspaceId,
  });
  let reconciliationRuntime:
    Awaited<ReturnType<typeof createMaintenanceRuntime>> | undefined;
  let dispatcher: ReturnType<typeof createOutboxDispatcherDatabase> | undefined;
  let producer: ReturnType<typeof createQueueProducer> | undefined;
  await runWithCleanup(
    async () => {
      const evidence = await child.evidence;
      signal.throwIfAborted();
      expect(await child.kill()).toBe('SIGKILL');
      expect(evidence.injectionPoint).toBe(selected.injectionPoint);
      signal.throwIfAborted();
      reconciliationRuntime = await createMaintenanceRuntime({
        maintenanceDatabase: maintenanceConfig(
          parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
        ),
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
        }),
        redisUrl,
      });
      signal.throwIfAborted();
      dispatcher = createOutboxDispatcherDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          ownerRole: 'pertexo_owner',
        }),
      );
      producer = createQueueProducer({ redisUrl });
      const ownedRuntime = reconciliationRuntime;
      const ownedDispatcher = dispatcher;
      const ownedProducer = producer;
      await Promise.all([
        ownedRuntime.consumer.waitUntilReady(5_000),
        ownedDispatcher.checkReadiness(),
        ownedProducer.waitUntilReady(5_000),
      ]);
      signal.throwIfAborted();
      const publishedEventIds = new Set<string>();
      await waitFor(
        async () => {
          signal.throwIfAborted();
          const batch = await ownedDispatcher.claimBatch({
            enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
            leaseDurationMillis: 5_000,
            leaseOwner: 'preview-sigkill-integration',
            leaseToken: randomUUID(),
            limit: 20,
          });
          for (const event of batch.events) {
            if (
              event.aggregateId !== accepted.previewRunId ||
              publishedEventIds.has(event.id)
            )
              continue;
            await ownedProducer.publish(
              parseQueueJob({ name: event.jobName, data: event.payload }),
            );
            if (
              !(await ownedDispatcher.markPublished(event.id, event.leaseToken))
            )
              throw new Error(
                `Preview reconciliation event ${event.id} lost its lease`,
              );
            publishedEventIds.add(event.id);
          }
          return publishedEventIds.size;
        },
        (value) => value === 1,
      );
      signal.throwIfAborted();
      const state = await waitFor(
        () => previewState(accepted.previewRunId),
        (value) => value?.run_status === selected.expectedStatus,
      );
      signal.throwIfAborted();
      expect(state?.run_status).toBe(selected.expectedStatus);
      expect(Number(state?.attempt_fence)).toBe(selected.fence);
      if ('providerIdempotencyKey' in selected.overrides) {
        expect(evidence.providerIdempotencyKey).toBe(
          selected.overrides.providerIdempotencyKey,
        );
        const pinnedKey = await withTenantScopedWorker((client) =>
          client.query<{ provider_idempotency_key: string | null }>(
            `select provider_idempotency_key from app.preview_attempts where workspace_id=$1 and id=$2`,
            [workspaceId, accepted.previewAttemptId],
          ),
        );
        expect(pinnedKey.rows[0]?.provider_idempotency_key).toBe(
          selected.overrides.providerIdempotencyKey,
        );
      }
      const receipts = await waitFor(
        () => {
          signal.throwIfAborted();
          return withTenantScopedWorker((client) =>
            client.query<{ completed: string; count: string }>(
              `select count(*)::text as count, count(completed_at)::text as completed
               from app.inbox_receipts where consumer_name='preview-attempt-reconciler' and message_id=any($1::uuid[])`,
              [[...publishedEventIds]],
            ),
          );
        },
        (value) => value.rows[0]?.completed === '1',
      );
      expect(receipts.rows[0]).toEqual({ completed: '1', count: '1' });
    },
    async () => {
      const errors: unknown[] = [];
      await child.kill().catch((error: unknown) => errors.push(error));
      await reconciliationRuntime
        ?.close()
        .catch((error: unknown) => errors.push(error));
      await producer?.close().catch((error: unknown) => errors.push(error));
      await dispatcher?.close().catch((error: unknown) => errors.push(error));
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          'Preview SIGKILL reconciliation cleanup failed',
        );
    },
    'Preview SIGKILL reconciliation',
  );
}
