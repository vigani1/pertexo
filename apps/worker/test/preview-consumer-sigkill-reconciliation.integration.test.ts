import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, parseQueueJob } from '@pertexo/queue';
import { describe, expect, it } from 'vitest';

import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import { spawnPreviewCrashChild } from './support/preview-consumer-crash-process.support.js';
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
} from './support/preview-consumer.integration.support.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration('preview SIGKILL reconciliation', () => {
  it('preserves durable reconciliation decisions after lease-owner SIGKILL', async () => {
    const cases = [
      {
        complete: false,
        expectedStatus: 'queued',
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
        markDispatched: false,
        overrides: {
          mayCauseExternalSideEffect: false,
          sideEffectClass: 'safe' as const,
        },
      },
    ] as const;
    const fixtures = await Promise.all(
      cases.map(async (selected, index) => {
        const traceparent = validTraceparent;
        const accepted = await withTenantAccept(
          acceptanceInput(traceparent, selected.overrides),
        );
        const payload = {
          schemaVersion: 1 as const,
          workspaceId,
          outboxEventId: accepted.outboxEventId,
          previewRunId: accepted.previewRunId,
          previewAttemptId: accepted.previewAttemptId,
          traceparent,
        };
        const workerId = `preview-sigkill-${String(index)}-${randomUUID().slice(0, 8)}`;
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
          workerId,
          workerUrl: databaseUrl(workerUrl),
          workspaceId,
        });
        const evidence = await child.evidence;
        return { accepted, child, evidence, selected };
      }),
    );
    const signals = await Promise.all(
      fixtures.map(async ({ child }) => child.kill()),
    );
    expect(signals).toEqual(cases.map(() => 'SIGKILL'));
    expect(fixtures.map(({ evidence }) => evidence.injectionPoint)).toEqual([
      'preview.claim_committed_before_process_exit',
      'preview.dispatch_marker_committed_before_process_exit',
      'preview.dispatch_marker_committed_before_process_exit',
      'preview.dispatch_marker_committed_before_process_exit',
      'preview.outcome_committed_before_process_exit',
    ]);

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
      const targetRunIds = new Set(
        fixtures.map(({ accepted }) => accepted.previewRunId),
      );
      const claimedEvents = new Map<
        string,
        Awaited<ReturnType<typeof dispatcher.claimBatch>>['events'][number]
      >();
      const events = await waitFor(
        async () => {
          const batch = await dispatcher.claimBatch({
            enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
            leaseDurationMillis: 5_000,
            leaseOwner: 'preview-sigkill-integration',
            leaseToken: randomUUID(),
            limit: 20,
            maxAttempts: 3,
          });
          for (const event of batch.events) {
            if (targetRunIds.has(event.aggregateId))
              claimedEvents.set(event.id, event);
          }
          return [...claimedEvents.values()];
        },
        (value) => value.length === cases.length,
      );
      await Promise.all(
        events.map(async (event) => {
          await producer.publish(
            parseQueueJob({ name: event.jobName, data: event.payload }),
          );
          await dispatcher.markPublished(event.id, event.leaseToken);
        }),
      );
      const states = await waitFor(
        () =>
          Promise.all(
            fixtures.map(({ accepted }) => previewState(accepted.previewRunId)),
          ),
        (values) =>
          values.every(
            (value, index) =>
              value?.run_status === cases[index]?.expectedStatus,
          ),
      );
      expect(states.map((state) => state?.run_status)).toEqual(
        cases.map(({ expectedStatus }) => expectedStatus),
      );
      expect(states.map((state) => Number(state?.attempt_fence))).toEqual([
        2, 2, 2, 2, 1,
      ]);
      const keyed = fixtures[2];
      expect(keyed?.evidence.providerIdempotencyKey).toBe(
        cases[2].overrides.providerIdempotencyKey,
      );
      const pinnedKey = await withTenantScopedWorker((client) =>
        client.query<{ provider_idempotency_key: string | null }>(
          `select provider_idempotency_key from app.preview_attempts
           where workspace_id=$1 and id=$2`,
          [workspaceId, keyed?.accepted.previewAttemptId],
        ),
      );
      expect(pinnedKey.rows[0]?.provider_idempotency_key).toBe(
        cases[2].overrides.providerIdempotencyKey,
      );
      const receipts = await withTenantScopedWorker((client) =>
        client.query<{ completed: string; count: string }>(
          `select count(*)::text as count,
                  count(completed_at)::text as completed
           from app.inbox_receipts
           where consumer_name='preview-attempt-reconciler'
             and message_id=any($1::uuid[])`,
          [events.map((event) => event.id)],
        ),
      );
      expect(receipts.rows[0]).toEqual({
        completed: String(cases.length),
        count: String(cases.length),
      });
    } finally {
      await Promise.allSettled([
        reconciliationRuntime.close(),
        dispatcher.close(),
        producer.close(),
      ]);
    }
  });
});
