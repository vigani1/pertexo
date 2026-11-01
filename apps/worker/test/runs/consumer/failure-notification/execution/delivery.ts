import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createFailureNotificationStore } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  QUEUE_NAME,
} from '@pertexo/queue';
import { Queue } from 'bullmq';

import { expect } from 'vitest';
import { createProviderFailureNotificationDelivery } from '../../../../../src/notifications/failure-delivery.js';
import type { createMaintenanceRuntime } from '../../../../../src/maintenance/runtime.js';
import { WorkerDrainState } from '../../../../../src/runtime/shutdown/drain-state.js';
import {
  createFailureNotificationDispatcher,
  dispatchFairRounds,
} from '../../../../support/coordinator/dispatch.js';

import {
  databaseUrl,
  redisConnection,
  redisUrl,
  startService,
  stopService,
  waitFor,
  workerQuery,
  workerUrl,
  workspaceId,
} from '../fixture.js';
import type { FailureNotificationScenario } from './contract.js';
import { testMaintenanceRuntime } from '../../../../support/runtime-factories.js';

export async function qualifyRecoveredNotificationDelivery(
  scenario: FailureNotificationScenario,
) {
  const {
    slackConnectionId,
    accepted,
    intentId,
    initialOutboxEventId,
    slackIntentId,
    slackOutboxEventId,
    slackPayload,
    initialTruth,
  } = scenario;
  const deliveries: string[] = [];
  const slackDeliveries: string[] = [];
  let providerStore:
    ReturnType<typeof createFailureNotificationStore> | undefined;
  let runtime: Awaited<ReturnType<typeof createMaintenanceRuntime>> | undefined;
  let dispatcher:
    Awaited<ReturnType<typeof createFailureNotificationDispatcher>> | undefined;
  let producer: ReturnType<typeof createQueueProducer> | undefined;
  let queue: Queue | undefined;
  let scenarioError: unknown;
  try {
    providerStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 2,
      }),
    );
    const providerDelivery = createProviderFailureNotificationDelivery({
      store: providerStore,
      encryption: {
        open: (_sealed, encryptionContext) =>
          Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify(
                encryptionContext.connectionId === slackConnectionId
                  ? {
                      type: 'slack_bot_token',
                      botToken: 'xoxb-integration-only',
                    }
                  : {
                      type: 'resend_api_key',
                      apiKey: 're_integration_only',
                      fromEmail: 'sender@example.test',
                    },
              ),
            ),
          ),
      },
      slack: {
        sendMessage: async (input) => {
          await input.beforeDispatch();
          expect(input).toMatchObject({ channelId: 'C12345' });
          slackDeliveries.push(input.channelId);
          throw new Error('unexpected failure after dispatch fence');
        },
      },
      email: {
        sendNotification: async (input) => {
          await input.beforeDispatch();
          expect(input).toMatchObject({
            toEmail: 'failure-notification@example.test',
            idempotencyKey: `failure-notification:${intentId}`,
          });
          deliveries.push(input.idempotencyKey);
          return { kind: 'succeeded', emailId: randomUUID() };
        },
      },
      workerId: 'failure-notification-integration-worker',
    });
    runtime = await testMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        redisUrl,
        failureNotificationDelivery: providerDelivery,
      },
      {
        consumerFactory: (options) =>
          createQueueConsumer({ ...options, drainTimeoutMs: 2_000 }),
      },
    );
    let drainState = new WorkerDrainState();
    dispatcher = await createFailureNotificationDispatcher(drainState);
    await stopService('redis');
    await expect(dispatcher.checkReadiness()).rejects.toThrow();
    // Without Redis the claimed event cannot publish; its lease is released
    // for a later attempt.
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 0,
    });
    await expect(
      workerQuery<{ status: string }>(
        `select status from app.run_failure_notification_intents
              where workspace_id=$1 and id=any($2::uuid[]) order by id`,
        [workspaceId, [intentId, slackIntentId]],
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { status: 'retry' },
        { status: 'outcome_unknown' },
      ]),
    );
    await startService('redis');
    await Promise.all([
      runtime.consumer.waitUntilReady(5_000),
      dispatcher.checkReadiness(),
    ]);
    const reconstructionErrors: unknown[] = [];
    await dispatcher
      .close()
      .catch((error: unknown) => reconstructionErrors.push(error));
    await runtime
      .close()
      .catch((error: unknown) => reconstructionErrors.push(error));
    if (reconstructionErrors.length > 0)
      throw new AggregateError(
        reconstructionErrors,
        'Failure notification runtime reconstruction drain failed',
      );
    runtime = await testMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        redisUrl,
        failureNotificationDelivery: providerDelivery,
      },
      {
        consumerFactory: (options) =>
          createQueueConsumer({ ...options, drainTimeoutMs: 2_000 }),
      },
    );
    drainState = new WorkerDrainState();
    dispatcher = await createFailureNotificationDispatcher(drainState);
    producer = createQueueProducer({ redisUrl });
    const activeProducer = producer;
    queue = new Queue(QUEUE_NAME.maintenance, {
      connection: redisConnection(),
    });
    const activeQueue = queue;
    await Promise.all([
      runtime.consumer.waitUntilReady(5_000),
      dispatcher.checkReadiness(),
      activeProducer.waitUntilReady(5_000),
    ]);
    const recovered = await waitFor(
      () =>
        workerQuery<{
          id: string;
          payload: FailureNotificationScenario['initialPayload'];
        }>(
          `select id,payload from app.outbox_events
                where workspace_id=$1 and aggregate_id=$2
                  and job_name='deliver-run-failure-notification'
                  and id<>$3 order by created_at,id`,
          [workspaceId, intentId, initialOutboxEventId],
        ),
      (rows) => rows.length === 2,
    );
    await expect(dispatchFairRounds(dispatcher, 5)).resolves.toMatchObject({
      claimed: 5,
      published: 5,
    });
    const emailTerminal = await waitFor(
      () =>
        workerQuery<{ safe_error_code: string | null; status: string }>(
          `select status,safe_error_code from app.run_failure_notification_intents
                where workspace_id=$1 and id=$2`,
          [workspaceId, intentId],
        ),
      (rows) =>
        ['delivered', 'dead_letter', 'outcome_unknown'].includes(
          rows[0]?.status ?? '',
        ),
    );
    expect(emailTerminal).toEqual([
      { status: 'delivered', safe_error_code: null },
    ]);
    expect(deliveries).toEqual([`failure-notification:${intentId}`]);
    await waitFor(
      () =>
        workerQuery<{ status: string }>(
          `select status from app.run_failure_notification_intents
                where workspace_id=$1 and id=$2`,
          [workspaceId, slackIntentId],
        ),
      (rows) => rows[0]?.status === 'outcome_unknown',
    );
    expect(slackDeliveries).toEqual([]);

    const retry = recovered[0];
    if (retry === undefined) throw new Error('notification recovery missing');
    const completedJob = await activeQueue.getJob(`outbox-${retry.id}`);
    await completedJob?.remove();
    await activeProducer.publish({
      name: JOB_NAME.deliverRunFailureNotification,
      data: retry.payload,
    });
    await waitFor(
      async () => (await activeQueue.getJob(`outbox-${retry.id}`))?.getState(),
      (state) => state === 'completed',
    );
    expect(deliveries).toHaveLength(1);
    const slackCompletedJob = await activeQueue.getJob(
      `outbox-${slackOutboxEventId}`,
    );
    await slackCompletedJob?.remove();
    await activeProducer.publish({
      name: JOB_NAME.deliverRunFailureNotification,
      data: slackPayload,
    });
    await waitFor(
      async () =>
        (await activeQueue.getJob(`outbox-${slackOutboxEventId}`))?.getState(),
      (state) => state === 'completed',
    );
    expect(slackDeliveries).toHaveLength(0);
    drainState.beginDrain();
    await expect(dispatcher.checkReadiness()).rejects.toThrow(/draining/u);
    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 0,
      failed: 0,
      outcomeUnknown: 0,
      published: 0,
      stale: 0,
    });
    const dispatcherCloseStartedAt = performance.now();
    await dispatcher.close();
    expect(performance.now() - dispatcherCloseStartedAt).toBeLessThan(2_000);
    await expect(
      workerQuery<{
        event_count: string;
        revision: number;
        run_status: string;
      }>(
        `select run.status run_status,checkpoint.revision,
                    (select count(*)::text from app.run_events event
                      where event.workflow_run_id=run.id) event_count
               from app.workflow_runs run
               join app.run_checkpoints checkpoint on checkpoint.workflow_run_id=run.id
              where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, accepted.runId],
      ),
    ).resolves.toEqual(initialTruth);
    const persisted = await workerQuery<{
      audit: string;
      events: string;
      outbox: string;
    }>(
      `select
             coalesce((select string_agg(coalesce(safe_error_code,''),' ')
               from app.run_failure_notification_audit_facts
               where notification_intent_id=any($2::uuid[])),'') audit,
             coalesce((select string_agg(payload::text,' ')
               from app.run_events where workflow_run_id=$3),'') events,
             coalesce((select string_agg(payload::text,' ')
               from app.outbox_events where aggregate_id=any($2::uuid[])),'') outbox
           from app.workspaces where id=$1`,
      [workspaceId, [intentId, slackIntentId], accepted.runId],
    );
    expect(JSON.stringify(persisted)).not.toMatch(
      /failure-notification@example\.test|re_integration_only|sender@example\.test|xoxb-integration-only|C12345/i,
    );
  } catch (error: unknown) {
    scenarioError = error;
  }
  const errors: unknown[] = scenarioError === undefined ? [] : [scenarioError];
  const attemptCleanup = async (
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    await Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        errors.push(error);
      });
  };
  await attemptCleanup(() => startService('redis'));
  if (dispatcher !== undefined) await attemptCleanup(() => dispatcher.close());
  if (runtime !== undefined) await attemptCleanup(() => runtime.close());
  if (producer !== undefined) await attemptCleanup(() => producer.close());
  if (queue !== undefined) {
    await attemptCleanup(() => queue.obliterate({ force: true }));
    await attemptCleanup(() => queue.close());
  }
  if (providerStore !== undefined)
    await attemptCleanup(() => providerStore.close());
  if (errors.length === 1 && scenarioError !== undefined)
    throw scenarioError instanceof Error
      ? scenarioError
      : new Error('Failure notification scenario failed', {
          cause: scenarioError,
        });
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Failure notification scenario and cleanup failed',
    );
}
