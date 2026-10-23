import { it, expect } from 'vitest';

import {
  Pool,
  asOwner,
  asRuntime,
  databaseUrl,
  waitForApplicationLocks,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

import {
  commitPinnedFailureNotificationRun,
  failureNotificationIdentity,
  createTestFailureNotificationStore,
  closeFailureNotificationFixture,
} from '../fixture.js';

export function registerCancelsCompletionBeforeCheckoutIntent(): void {
  it('cancels completion before checkout and while its intent lock is blocked', async () => {
    const preabortRun = await commitPinnedFailureNotificationRun();
    const preabortIdentity = await failureNotificationIdentity(
      preabortRun.runId,
    );
    const { applicationName: preabortApplicationName, store: preabortStore } =
      createTestFailureNotificationStore();
    const preabortConnectionsBefore = await asOwner(workspaceA, (client) =>
      client.query<{ connections: number }>(
        `select count(*)::int connections from pg_stat_activity
            where datname=current_database() and application_name=$1`,
        [preabortApplicationName],
      ),
    );
    const preabortController = new AbortController();
    preabortController.abort();
    try {
      await expect(
        preabortStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: preabortIdentity.intent_id,
          attemptNumber: 1,
          maxAttempts: 3,
          retryDelaySeconds: 30,
          result: {
            kind: 'retry',
            safeErrorCode: 'provider.unavailable',
            possiblyDispatched: false,
          },
          signal: preabortController.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const preabortConnections = await asOwner(workspaceA, (client) =>
        client.query<{ connections: number }>(
          `select count(*)::int connections from pg_stat_activity
            where datname=current_database() and application_name=$1`,
          [preabortApplicationName],
        ),
      );
      expect(preabortConnections.rows[0]?.connections).toBe(
        preabortConnectionsBefore.rows[0]?.connections,
      );
    } finally {
      await closeFailureNotificationFixture(preabortStore);
    }

    const blockedRun = await commitPinnedFailureNotificationRun();
    const blockedIdentity = await failureNotificationIdentity(blockedRun.runId);
    const { applicationName: blockedApplicationName, store: blockedStore } =
      createTestFailureNotificationStore();
    const claim = await blockedStore.claimDelivery({
      workspaceId: workspaceA,
      intentId: blockedIdentity.intent_id,
      delivery: {
        outboxEventId: blockedIdentity.outbox_id,
        payloadChecksum: blockedIdentity.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    });
    if (claim.kind !== 'ready') throw new Error('Blocked claim missing');
    const blockerPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    const blocker = await blockerPool.connect();
    const controller = new AbortController();
    let completion: Promise<'completed' | 'stale'> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await blocker.query(
        `select id from app.run_failure_notification_intents
          where workspace_id=$1 and id=$2 for update`,
        [workspaceA, blockedIdentity.intent_id],
      );
      completion = blockedStore.completeDelivery({
        workspaceId: workspaceA,
        intentId: blockedIdentity.intent_id,
        attemptNumber: claim.attemptNumber,
        maxAttempts: 3,
        retryDelaySeconds: 30,
        result: {
          kind: 'retry',
          safeErrorCode: 'provider.unavailable',
          possiblyDispatched: false,
        },
        signal: controller.signal,
      });
      await waitForApplicationLocks(blockedApplicationName, 1);
      controller.abort();
      await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
      await blocker.query('commit');
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ outbox_count: number; status: string }>(
            `select intent.status,
                    (select count(*)::int from app.outbox_events outbox
                      where outbox.aggregate_id=intent.id) outbox_count
               from app.run_failure_notification_intents intent
              where intent.workspace_id=$1 and intent.id=$2`,
            [workspaceA, blockedIdentity.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [{ outbox_count: 1, status: 'claimed' }],
      });
      await expect(
        blockedStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: blockedIdentity.intent_id,
          attemptNumber: claim.attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            kind: 'definite_failure',
            safeErrorCode: 'provider.rejected',
            possiblyDispatched: false,
          },
        }),
      ).resolves.toBe('completed');
    } finally {
      controller.abort();
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
      await Promise.allSettled([
        completion,
        closeFailureNotificationFixture(blockedStore),
      ]);
    }
  });

  it('surfaces commit-ack uncertainty while a repeated completion observes committed truth', async () => {
    const { runId } = await commitPinnedFailureNotificationRun();
    const first = await failureNotificationIdentity(runId);
    const { store: ordinaryStore } = createTestFailureNotificationStore();
    const claimed = await ordinaryStore.claimDelivery({
      workspaceId: workspaceA,
      intentId: first.intent_id,
      delivery: {
        outboxEventId: first.outbox_id,
        payloadChecksum: first.payload_checksum,
      },
      recoverySeconds: 30,
      maxAttempts: 3,
    });
    if (claimed.kind !== 'ready')
      throw new Error('Commit-uncertainty claim missing');
    await ordinaryStore.fenceDispatch({
      workspaceId: workspaceA,
      intentId: first.intent_id,
      attemptNumber: claimed.attemptNumber,
      deliveryBinding: `email:sha256:${'9'.repeat(64)}`,
    });
    const { store: uncertainStore } = createTestFailureNotificationStore({
      matches: (sql) => sql.trim().toLowerCase() === 'commit',
      message: 'Injected notification commit acknowledgement loss',
    });
    const completion = {
      workspaceId: workspaceA,
      intentId: first.intent_id,
      attemptNumber: claimed.attemptNumber,
      maxAttempts: 3,
      retryDelaySeconds: 0,
      result: {
        kind: 'delivered' as const,
        possiblyDispatched: true as const,
        providerReference: 'provider-reference-committed',
      },
    };
    try {
      await expect(uncertainStore.completeDelivery(completion)).rejects.toThrow(
        'Injected notification commit acknowledgement loss',
      );
      await expect(ordinaryStore.completeDelivery(completion)).resolves.toBe(
        'stale',
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            delivered_facts: number;
            provider_reference: string;
            status: string;
          }>(
            `select intent.status,intent.provider_reference,
                    (select count(*)::int
                       from app.run_failure_notification_audit_facts fact
                      where fact.notification_intent_id=intent.id
                        and fact.fact_type='delivered') delivered_facts
               from app.run_failure_notification_intents intent
              where intent.workspace_id=$1 and intent.id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            delivered_facts: 1,
            provider_reference: 'provider-reference-committed',
            status: 'delivered',
          },
        ],
      });
    } finally {
      await Promise.allSettled([
        closeFailureNotificationFixture(ordinaryStore),
        closeFailureNotificationFixture(uncertainStore),
      ]);
    }
  });
}
