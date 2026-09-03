import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_NAME,
  Pool,
  QUEUE_NAME,
  Queue,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  WorkerDrainState,
  actorId,
  adminUrl,
  apiQuery,
  canonicalOutboxPayloadChecksum,
  cleanupFixture,
  createFailureNotificationStore,
  createOutboxDispatcherDatabase,
  createPreviewMaintenanceRuntime,
  createProviderFailureNotificationDelivery,
  createQueueProducer,
  databaseUrl,
  enabled,
  dispatcherUrl,
  parseDatabaseConfig,
  performance,
  randomUUID,
  redisConnection,
  redisUrl,
  restoreServices,
  setupFixture,
  startService,
  stopService,
  waitFor,
  workerQuery,
  workerUrl,
  workflowId,
  workspaceId,
} from './coordinator-consumer.fixtures.js';
import {
  createFailureNotificationDispatcher,
  dispatchFairRounds,
} from './support/coordinator-dispatch-fixtures.js';
import {
  acceptRun,
  terminalizeFailedRun,
} from './support/coordinator-run-fixtures.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Failure notification transport resilience', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('recovers failure notification dispatch through PostgreSQL and BullMQ without changing run truth', async () => {
    const destinationId = randomUUID();
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const slackDestinationId = randomUUID();
    const slackConnectionId = randomUUID();
    const slackSecretVersionId = randomUUID();
    const fixturePool = new Pool({
      connectionString: databaseUrl(adminUrl),
      max: 1,
    });
    try {
      await fixturePool.query(
        `with connection_row as (
            insert into app.connections (
              id,workspace_id,provider_key,name,auth_type,status,
              current_secret_version_id,created_by
            ) values ($4,$1,'email','Failure notification email',
              'resend_api_key','active',$5,$6)
          ), secret_row as (
            insert into app.connection_secret_versions (
              id,workspace_id,connection_id,schema_version,kms_key_reference,
              encrypted_data_key,ciphertext,nonce,auth_tag,created_by
            ) values ($5,$1,$4,1,'kms','key','cipher','AAAAAAAAAAAAAAAA',
              'AAAAAAAAAAAAAAAAAAAAAA',$6)
          ), slack_connection_row as (
            insert into app.connections (
              id,workspace_id,provider_key,name,auth_type,status,
              current_secret_version_id,created_by
            ) values ($8,$1,'slack','Failure notification Slack',
              'slack_bot_token','active',$9,$6)
          ), slack_secret_row as (
            insert into app.connection_secret_versions (
              id,workspace_id,connection_id,schema_version,kms_key_reference,
              encrypted_data_key,ciphertext,nonce,auth_tag,created_by
            ) values ($9,$1,$8,1,'kms','slack-key','slack-cipher',
              'BBBBBBBBBBBBBBBB','BBBBBBBBBBBBBBBBBBBBBB',$6)
          ), destination_row as (
            insert into app.failure_notification_destinations
              (id,workspace_id,kind,status,current_config_version,created_by)
            values ($2,$1,'email','enabled',1,$6)
          ), destination_version as (
            insert into app.failure_notification_destination_versions
              (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
            values ($1,$2,1,'email','idempotent_with_key',$7::jsonb,$6)
          ), slack_destination_row as (
            insert into app.failure_notification_destinations
              (id,workspace_id,kind,status,current_config_version,created_by)
            values ($10,$1,'slack','enabled',1,$6)
          ), slack_destination_version as (
            insert into app.failure_notification_destination_versions
              (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
            values ($1,$10,1,'slack','unsafe',$11::jsonb,$6)
          )
          insert into app.workflow_failure_notification_policies
            (workspace_id,workflow_id,destination_id,updated_by)
          values ($1,$3,$2,$6)`,
        [
          workspaceId,
          destinationId,
          workflowId,
          connectionId,
          secretVersionId,
          actorId,
          JSON.stringify({
            connectionId,
            toEmail: 'failure-notification@example.test',
          }),
          slackConnectionId,
          slackSecretVersionId,
          slackDestinationId,
          JSON.stringify({
            connectionId: slackConnectionId,
            channelId: 'C12345',
          }),
        ],
      );
    } finally {
      await fixturePool.end();
    }
    const accepted = await acceptRun();
    const emailIdentity = await terminalizeFailedRun(accepted);
    await apiQuery(
      `update app.workflow_failure_notification_policies set destination_id=$3
          where workspace_id=$1 and workflow_id=$2`,
      [workspaceId, workflowId, slackDestinationId],
    );
    const slackAccepted = await acceptRun();
    const slackIdentity = await terminalizeFailedRun(slackAccepted);
    const intentId = emailIdentity.intentId;
    const initialOutboxEventId = emailIdentity.outboxEventId;
    const initialPayload = {
      schemaVersion: 1 as const,
      workspaceId,
      notificationIntentId: intentId,
      outboxEventId: initialOutboxEventId,
    };
    const slackIntentId = slackIdentity.intentId;
    const slackOutboxEventId = slackIdentity.outboxEventId;
    const slackPayload = {
      schemaVersion: 1 as const,
      workspaceId,
      notificationIntentId: slackIntentId,
      outboxEventId: slackOutboxEventId,
    };
    const initialTruth = await workerQuery<{
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
    );
    const store = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 2,
      }),
    );
    try {
      const initialClaim = await store.claimDelivery({
        workspaceId,
        intentId,
        delivery: {
          outboxEventId: initialOutboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(initialPayload),
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      });
      expect(initialClaim).toMatchObject({ kind: 'ready', attemptNumber: 1 });
      const slackClaim = await store.claimDelivery({
        workspaceId,
        intentId: slackIntentId,
        delivery: {
          outboxEventId: slackOutboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(slackPayload),
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      });
      expect(slackClaim).toMatchObject({ kind: 'ready', attemptNumber: 1 });
      const destinationProof = await workerQuery<{
        auth_type: string;
        connection_status: string;
        current_secret_version_id: string;
        destination_kind: string;
        intent_secret_version_id: string;
        provider_key: string;
        secret_id: string;
        version_kind: string;
      }>(
        `select destination.kind destination_kind,version.kind version_kind,
                  connection.provider_key,connection.auth_type,
                  connection.status connection_status,
                  connection.current_secret_version_id,
                  intent.connection_secret_version_id intent_secret_version_id,
                  secret.id secret_id
             from app.run_failure_notification_intents intent
             join app.failure_notification_destinations destination
               on destination.workspace_id=intent.workspace_id
              and destination.id=intent.destination_id
             join app.failure_notification_destination_versions version
               on version.workspace_id=intent.workspace_id
              and version.destination_id=intent.destination_id
              and version.version=intent.destination_config_version
             join app.connections connection
               on connection.workspace_id=intent.workspace_id
              and connection.id=(version.config->>'connectionId')::uuid
             join app.connection_secret_versions secret
               on secret.workspace_id=connection.workspace_id
              and secret.connection_id=connection.id
              and secret.id=intent.connection_secret_version_id
            where intent.workspace_id=$1 and intent.id=$2`,
        [workspaceId, intentId],
      );
      expect(destinationProof).toEqual([
        {
          destination_kind: 'email',
          version_kind: 'email',
          provider_key: 'email',
          secret_id: secretVersionId,
          auth_type: 'resend_api_key',
          connection_status: 'active',
          current_secret_version_id: secretVersionId,
          intent_secret_version_id: secretVersionId,
        },
      ]);
      if (initialClaim.kind !== 'ready' || slackClaim.kind !== 'ready')
        throw new Error('destructive destination claims were not ready');
      const preFenceProviderCalls: string[] = [];
      const preFenceDelivery = createProviderFailureNotificationDelivery({
        store,
        encryption: {
          open: () =>
            Promise.reject(
              new Error('PostgreSQL loss must fail before credential opening'),
            ),
        },
        slack: {
          sendMessage: () => {
            preFenceProviderCalls.push('slack');
            return Promise.resolve({
              kind: 'succeeded',
              channelId: 'unexpected',
              messageTs: 'unexpected',
            });
          },
        },
        email: {
          sendNotification: () => {
            preFenceProviderCalls.push('email');
            return Promise.resolve({
              kind: 'succeeded',
              emailId: 'unexpected',
            });
          },
        },
        workerId: 'failure-notification-postgres-loss',
      });
      const readinessDatabase = createOutboxDispatcherDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          connectionTimeoutMillis: 1_000,
          max: 1,
        }),
      );
      try {
        await stopService('postgres');
        await expect(readinessDatabase.checkReadiness()).rejects.toThrow();
        for (const [claim, claimedIntentId] of [
          [initialClaim, intentId],
          [slackClaim, slackIntentId],
        ] as const) {
          await expect(
            preFenceDelivery.deliver({
              context: claim.context,
              workspaceId,
              intentId: claimedIntentId,
              attemptNumber: claim.attemptNumber,
              destinationId: claim.destinationId,
              destinationConfigVersion: claim.destinationConfigVersion,
              idempotencyKey: claim.idempotencyKey,
              sideEffectClass: claim.sideEffectClass,
              connectionSecretVersionId: claim.connectionSecretVersionId,
              deliveryUnresolved: claim.deliveryUnresolved,
              ...(claim.deliveryBinding === undefined
                ? {}
                : { deliveryBinding: claim.deliveryBinding }),
              signal: new AbortController().signal,
            }),
          ).resolves.toMatchObject({
            kind: 'retry',
            possiblyDispatched: false,
          });
        }
        expect(preFenceProviderCalls).toEqual([]);
      } finally {
        await startService('postgres');
        await readinessDatabase.close();
      }
      await workerQuery(
        `update app.run_failure_notification_intents
              set recovery_at=clock_timestamp()-interval '1 second'
            where workspace_id=$1 and id=any($2::uuid[])`,
        [workspaceId, [intentId, slackIntentId]],
      );
      await expect(store.recoverDue(10, 3)).resolves.toBe(2);
      await expect(
        workerQuery<{ possibly_dispatched: boolean; status: string }>(
          `select status,possibly_dispatched
               from app.run_failure_notification_intents
              where workspace_id=$1 and id=any($2::uuid[]) order by id`,
          [workspaceId, [intentId, slackIntentId]],
        ),
      ).resolves.toEqual([
        { status: 'retry', possibly_dispatched: false },
        { status: 'retry', possibly_dispatched: false },
      ]);

      const retryOutboxes = await workerQuery<{
        aggregate_id: string;
        id: string;
        payload_checksum: string;
      }>(
        `select distinct on (aggregate_id) aggregate_id,id,payload_checksum
             from app.outbox_events
            where workspace_id=$1 and aggregate_id=any($2::uuid[])
            order by aggregate_id,created_at desc,id desc`,
        [workspaceId, [intentId, slackIntentId]],
      );
      const blockedClaims = await Promise.all(
        retryOutboxes.map(async (outbox) => ({
          intentId: outbox.aggregate_id,
          claim: await store.claimDelivery({
            workspaceId,
            intentId: outbox.aggregate_id,
            delivery: {
              outboxEventId: outbox.id,
              payloadChecksum: outbox.payload_checksum,
            },
            recoverySeconds: 1,
            maxAttempts: 3,
          }),
        })),
      );
      expect(blockedClaims).toHaveLength(2);
      if (blockedClaims.some(({ claim }) => claim.kind !== 'ready'))
        throw new Error('blocked destination claims were not ready');

      const blockedProviderCalls: string[] = [];
      let enteredCount = 0;
      let resolveEntered: (() => void) | undefined;
      const allEntered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      const blockAfterFence = async (
        provider: 'email' | 'slack',
        signal: AbortSignal,
      ): Promise<never> => {
        blockedProviderCalls.push(provider);
        enteredCount += 1;
        if (enteredCount === 2) resolveEntered?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
        });
        throw new SecureHttpError(
          SECURE_HTTP_ERROR_CODE.canceled,
          'ambiguous',
          true,
        );
      };
      const blockedDelivery = createProviderFailureNotificationDelivery({
        store,
        encryption: {
          open: (_sealed, encryptionContext) =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify(
                  encryptionContext.connectionId === slackConnectionId
                    ? {
                        schemaVersion: 1,
                        type: 'slack_bot_token',
                        botToken: 'xoxb-integration-only',
                      }
                    : {
                        schemaVersion: 1,
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
            return blockAfterFence('slack', input.signal);
          },
        },
        email: {
          sendNotification: async (input) => {
            await input.beforeDispatch();
            expect(input.idempotencyKey).toBe(
              `failure-notification:v1:${intentId}`,
            );
            if (input.signal === undefined)
              throw new Error('blocked email dispatch signal missing');
            return blockAfterFence('email', input.signal);
          },
        },
        workerId: 'failure-notification-drain-worker',
      });
      const blockedControllers = blockedClaims.map(() => new AbortController());
      const blockedResults = blockedClaims.map(
        ({ claim, intentId: claimedId }, index) => {
          if (claim.kind !== 'ready')
            throw new Error('blocked claim changed kind');
          const controller = blockedControllers[index];
          if (controller === undefined)
            throw new Error('blocked controller missing');
          return blockedDelivery.deliver({
            context: claim.context,
            workspaceId,
            intentId: claimedId,
            attemptNumber: claim.attemptNumber,
            destinationId: claim.destinationId,
            destinationConfigVersion: claim.destinationConfigVersion,
            idempotencyKey: claim.idempotencyKey,
            sideEffectClass: claim.sideEffectClass,
            connectionSecretVersionId: claim.connectionSecretVersionId,
            deliveryUnresolved: claim.deliveryUnresolved,
            ...(claim.deliveryBinding === undefined
              ? {}
              : { deliveryBinding: claim.deliveryBinding }),
            signal: controller.signal,
          });
        },
      );
      await allEntered;
      const drainStartedAt = performance.now();
      for (const controller of blockedControllers) controller.abort();
      const settledBlockedResults = await Promise.all(blockedResults);
      expect(performance.now() - drainStartedAt).toBeLessThan(2_000);
      expect(blockedProviderCalls.sort()).toEqual(['email', 'slack']);

      for (const [index, blocked] of blockedClaims.entries()) {
        const result = settledBlockedResults[index];
        if (blocked.claim.kind !== 'ready' || result === undefined)
          throw new Error('blocked result identity missing');
        await expect(
          store.completeDelivery({
            workspaceId,
            intentId: blocked.intentId,
            attemptNumber: blocked.claim.attemptNumber,
            maxAttempts: 3,
            retryDelaySeconds: 0,
            result,
          }),
        ).resolves.toBe('completed');
      }
      const postDrain = await workerQuery<{
        delivery_binding: string | null;
        id: string;
        possibly_dispatched: boolean;
        status: string;
      }>(
        `select id,status,possibly_dispatched,delivery_binding
             from app.run_failure_notification_intents
            where workspace_id=$1 and id=any($2::uuid[])`,
        [workspaceId, [intentId, slackIntentId]],
      );
      expect(postDrain.find((row) => row.id === slackIntentId)).toMatchObject({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });
      const drainedEmail = postDrain.find((row) => row.id === intentId);
      expect(drainedEmail).toMatchObject({
        status: 'retry',
        possibly_dispatched: true,
      });
      expect(drainedEmail?.delivery_binding).toMatch(/^email:v1:sha256:/u);
    } finally {
      await store.close();
    }

    const deliveries: string[] = [];
    const slackDeliveries: string[] = [];
    const providerStore = createFailureNotificationStore(
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
                      schemaVersion: 1,
                      type: 'slack_bot_token',
                      botToken: 'xoxb-integration-only',
                    }
                  : {
                      schemaVersion: 1,
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
            idempotencyKey: `failure-notification:v1:${intentId}`,
          });
          deliveries.push(input.idempotencyKey);
          return { kind: 'succeeded', emailId: randomUUID() };
        },
      },
      workerId: 'failure-notification-integration-worker',
    });
    let runtime = await createPreviewMaintenanceRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      redisUrl,
      failureNotificationDelivery: providerDelivery,
    });
    let drainState = new WorkerDrainState();
    let dispatcher = createFailureNotificationDispatcher(
      runtime.consumer,
      drainState,
    );
    let producer: ReturnType<typeof createQueueProducer> | undefined;
    let queue: Queue | undefined;
    try {
      await stopService('redis');
      await expect(dispatcher.checkReadiness()).rejects.toThrow();
      await expect(dispatcher.dispatchOnce()).rejects.toThrow(
        /No ready composed consumer/u,
      );
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
      await Promise.allSettled([dispatcher.close(), runtime.close()]);
      runtime = await createPreviewMaintenanceRuntime({
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        redisUrl,
        failureNotificationDelivery: providerDelivery,
      });
      drainState = new WorkerDrainState();
      dispatcher = createFailureNotificationDispatcher(
        runtime.consumer,
        drainState,
      );
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
            payload: typeof initialPayload;
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
      expect(deliveries).toEqual([`failure-notification:v1:${intentId}`]);
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
        async () =>
          (await activeQueue.getJob(`outbox-${retry.id}`))?.getState(),
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
          (
            await activeQueue.getJob(`outbox-${slackOutboxEventId}`)
          )?.getState(),
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
               where notification_intent_id=$2),'') audit,
             coalesce((select string_agg(payload::text,' ')
               from app.run_events where workflow_run_id=$3),'') events,
             coalesce((select string_agg(payload::text,' ')
               from app.outbox_events where aggregate_id=$2),'') outbox
           from app.workspaces where id=$1`,
        [workspaceId, intentId, accepted.runId],
      );
      expect(JSON.stringify(persisted)).not.toMatch(
        /failure-notification@example\.test|re_integration_only|sender@example\.test|xoxb-integration-only|C12345/i,
      );
    } finally {
      await startService('redis').catch(() => undefined);
      await Promise.allSettled([
        dispatcher.close(),
        runtime.close(),
        providerStore.close(),
        producer?.close() ?? Promise.resolve(),
      ]);
      await queue?.obliterate({ force: true }).catch(() => undefined);
      await queue?.close();
    }
  }, 120_000);
});
