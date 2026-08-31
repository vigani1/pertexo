import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  claimPreviewDelivery,
  createOutboxDispatcherDatabase,
  markPreviewDispatched,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, parseQueueJob } from '@pertexo/queue';
import { describe, expect, it } from 'vitest';

import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import {
  acceptanceInput,
  databaseUrl,
  dispatcherUrl,
  previewState,
  redisUrl,
  validTraceparent,
  waitFor,
  withTenantAccept,
  workerPool,
  workerTransportIntegrationEnabled,
  workerUrl,
  workspaceId,
} from './support/preview-consumer.integration.support.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration('preview reconciliation transport', () => {
  it('delivers an expired unsafe lease to the durable reconciler through the outbox', async () => {
    const traceparent = validTraceparent(2);
    const accepted = await withTenantAccept(
      acceptanceInput(traceparent, {
        mayContactProvider: true,
        mayCauseExternalSideEffect: true,
        sideEffectClass: 'unsafe',
      }),
    );
    const executionPayload = {
      schemaVersion: 1 as const,
      workspaceId,
      outboxEventId: accepted.outboxEventId,
      previewRunId: accepted.previewRunId,
      previewAttemptId: accepted.previewAttemptId,
      traceparent,
    };
    const crashWorkerId = `preview-crash-${randomUUID().slice(0, 8)}`;
    const claimed = await claimPreviewDelivery(workerPool, {
      delivery: {
        outboxEventId: accepted.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(executionPayload),
      },
      leaseDurationSeconds: 1,
      previewAttemptId: accepted.previewAttemptId,
      previewRunId: accepted.previewRunId,
      workerId: crashWorkerId,
      workspaceId,
    });
    if (claimed.kind !== 'claimed') throw new Error('preview claim missing');
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: crashWorkerId,
    });

    const reconciliationRuntime = await createPreviewMaintenanceRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      redisUrl,
    });
    const dispatcher = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        ownerRole: 'pertexo_owner',
      }),
    );
    const producer = createQueueProducer({ redisUrl });
    try {
      await Promise.all([
        reconciliationRuntime.consumer.waitUntilReady(5_000),
        dispatcher.checkReadiness(),
        producer.waitUntilReady(5_000),
      ]);
      const batch = await waitFor(
        () =>
          dispatcher.claimBatch({
            enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
            leaseDurationMillis: 5_000,
            leaseOwner: 'preview-reconciliation-integration',
            leaseToken: randomUUID(),
            limit: 10,
            maxAttempts: 3,
          }),
        (value) => value.events.length > 0,
      );
      const event = batch.events.find(
        (candidate) => candidate.aggregateId === accepted.previewRunId,
      );
      if (event === undefined)
        throw new Error('due preview reconciliation outbox missing');
      const job = parseQueueJob({ name: event.jobName, data: event.payload });
      await producer.publish(job);
      await dispatcher.markPublished(event.id, event.leaseToken);

      const state = await waitFor(
        () => previewState(accepted.previewRunId),
        (value) => value?.run_status === 'outcome_unknown',
      );
      expect(state).toMatchObject({
        run_status: 'outcome_unknown',
        safe_error_code: 'preview.outcome_unknown',
      });
      expect(Number(state?.attempt_fence)).toBe(
        claimed.lease.attemptFenceToken + 1,
      );
    } finally {
      await Promise.allSettled([
        reconciliationRuntime.close(),
        dispatcher.close(),
        producer.close(),
      ]);
    }
  });
});
