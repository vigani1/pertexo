import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createOutboxDispatcherDatabase,
  type LeasedOutboxEvent,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { createTransportMetrics } from '@pertexo/observability/transport-metrics';
import { platformServingRegistryRelease } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import {
  ConnectionEnvelopeEncryption,
  createSlackClient,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createConnectionHealthSlackTransport } from '../../../infrastructure/testing/connection-health-slack-transport.mjs';
import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';
import { createMaintenanceRuntime } from '../src/maintenance/runtime.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { createRedisTestNamespace } from './support/redis-test-namespace.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import {
  createEditorBrowserWorkerLifetime,
  type EditorBrowserRuntimeConstruction,
} from './support/editor-browser-worker-lifetime.js';

if (process.env.REDIS_URL === undefined || process.send === undefined)
  throw new Error('Owned health worker needs Redis and IPC');
const namespace = createRedisTestNamespace(
  process.env.REDIS_URL,
  13,
  'connection-health-browser',
  {
    beforeCleanup: async () => {
      const approval = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Health ownership acknowledgment expired'));
        }, 5000);
        const handler = (value: unknown) => {
          if (
            !z
              .object({
                phase: z.enum([
                  'namespace-cleanup-approved',
                  'namespace-cleanup-denied',
                ]),
              })
              .safeParse(value).success
          )
            return;
          clearTimeout(timer);
          process.off('message', handler);
          if (
            (value as { phase: string }).phase === 'namespace-cleanup-approved'
          )
            resolve();
          else reject(new Error('Health namespace ownership lost'));
        };
        process.on('message', handler);
      });
      process.send?.({ phase: 'namespace-cleanup-request' });
      await approval;
    },
  },
);
const configSchema = z
  .object({
    workerUrl: z.string(),
    dispatcherUrl: z.string(),
    apiUrl: z.string(),
    migrationUrl: z.string(),
    connectionMasterKey: z.string().regex(/^[a-f0-9]{64}$/u),
    controlOrigin: z.url(),
  })
  .strict();
let configuration: z.output<typeof configSchema> | undefined;
let healthEnabled = false,
  stopping = false;
const shutdown = new AbortController();
const PUBLICATION_LEASE_MILLIS = 30_000;
let abandonmentUsed = false;
let abandonmentActivity:
  ReturnType<typeof abandonHealthPublication> | undefined;
const runtimeOwner = createEditorBrowserWorkerLifetime(namespace, construct);
let closing: Promise<void> | undefined;
function stop() {
  stopping = true;
  shutdown.abort();
  closing ??= (async () => {
    let success = true;
    try {
      await abandonmentActivity;
    } catch {
      success = false;
    }
    try {
      await runtimeOwner.close();
    } catch {
      success = false;
    }
    process.exitCode = success ? 0 : 1;
    try {
      if (process.connected)
        await new Promise<void>((resolve, reject) =>
          process.send?.(
            {
              phase: 'worker-shutdown',
              success,
              failures: success ? [] : ['shutdown'],
            },
            (error: Error | null) => {
              if (error === null) resolve();
              else reject(error);
            },
          ),
        );
    } catch {
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('disconnect', stop);
process.on('message', (value: unknown) => {
  const abandonment = z
    .object({
      phase: z.literal('abandon-health-publication'),
      requestId: z.uuid(),
    })
    .strict()
    .safeParse(value);
  if (abandonment.success && !stopping) {
    if (abandonmentUsed || abandonmentActivity !== undefined || healthEnabled) {
      process.send?.({
        phase: 'health-publication-abandoned',
        requestId: abandonment.data.requestId,
        success: false,
      });
      return;
    }
    abandonmentActivity = abandonHealthPublication();
    void abandonmentActivity.then(
      (claim) =>
        process.send?.({
          phase: 'health-publication-abandoned',
          requestId: abandonment.data.requestId,
          success: true,
          ...claim,
        }),
      () =>
        process.send?.({
          phase: 'health-publication-abandoned',
          requestId: abandonment.data.requestId,
          success: false,
        }),
    );
    return;
  }
  const parsed = z
    .object({ phase: z.literal('restart-worker-runtime'), requestId: z.uuid() })
    .safeParse(value);
  if (!parsed.success || stopping) return;
  if (abandonmentActivity !== undefined) {
    process.send?.({
      phase: 'worker-runtime-restarted',
      requestId: parsed.data.requestId,
      success: false,
    });
    return;
  }
  healthEnabled = true;
  void runtimeOwner.restart().then(
    () =>
      process.send?.({
        phase: 'worker-runtime-restarted',
        requestId: parsed.data.requestId,
        success: true,
      }),
    () => {
      process.send?.({
        phase: 'worker-runtime-restarted',
        requestId: parsed.data.requestId,
        success: false,
      });
      stop();
    },
  );
});

/** Lose a real dispatch owner immediately after its durable claim commits. */
async function abandonHealthPublication() {
  if (configuration === undefined || healthEnabled || abandonmentUsed)
    throw new Error('Health publication abandonment is unavailable');
  abandonmentUsed = true;
  const cleanup: (() => Promise<void>)[] = [];
  let originalFailure: unknown;
  let result:
    | Readonly<{
        outboxEventId: string;
        leaseToken: string;
        leaseOwner: string;
        leaseExpiresAt: string;
        publishCalls: number;
        releaseCalls: number;
        markCalls: number;
      }>
    | undefined;
  try {
    const database = parseDatabaseConfig({
      connectionString: configuration.workerUrl,
      max: 2,
    });
    const maintenance = await createMaintenanceRuntime({
      database,
      redisUrl: namespace.redisUrl,
      connectionHealthApplication: true,
      connectionRunHealthMode: 'enforce',
      previewReconciliation: false,
    });
    cleanup.push(() => maintenance.close());
    const store = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: configuration.dispatcherUrl,
        max: 2,
      }),
    );
    cleanup.push(() => store.close());
    const producer = createQueueProducer({ redisUrl: namespace.redisUrl });
    cleanup.push(() => producer.close());
    let claimed: LeasedOutboxEvent | undefined;
    let publishCalls = 0,
      releaseCalls = 0,
      markCalls = 0;
    const interruption = new Error('Owned publication interrupted after claim');
    const dispatcher = new OutboxDispatcher(
      {
        ...store,
        claimBatch: async (input) => {
          const result = await store.claimBatch(input);
          if (result.events.length !== 1)
            throw new Error('Expected one owned health claim');
          claimed = result.events[0];
          // Never return the event: the dispatcher cannot publish, settle, or release it.
          throw interruption;
        },
        releaseOrFail: (input) => {
          releaseCalls += 1;
          return store.releaseOrFail(input);
        },
        markPublished: (id, token) => {
          markCalls += 1;
          return store.markPublished(id, token);
        },
      },
      {
        close: () => producer.close(),
        observe: () => producer.observe(),
        isReady: () => producer.isReady(),
        waitUntilReady: (timeout) => producer.waitUntilReady(timeout),
        publish: (job) => {
          publishCalls += 1;
          return producer.publish(job);
        },
      },
      new WorkerDrainState(),
      {
        enabledJobNames: [JOB_NAME.applyConnectionHealthObservation],
        batchSize: 1,
        leaseDurationMillis: PUBLICATION_LEASE_MILLIS,
        leaseOwner: `health-abandoned-${randomUUID()}`,
        maxAttempts: 10,
        operationTimeoutMillis: 5000,
        pollIntervalMillis: 50,
        retryDelayMillis: 100,
      },
      createTransportMetrics(),
      createDispatchConsumerCapabilityRegistry([
        {
          jobName: JOB_NAME.applyConnectionHealthObservation,
          consumer: maintenance.consumer,
        },
      ]),
    );
    cleanup.splice(1, 2, () => dispatcher.close());
    await maintenance.consumer.waitUntilReady(5000);
    await maintenance.checkReadiness();
    await dispatcher.checkReadiness();
    try {
      await dispatcher.dispatchOnce();
      throw new Error('Expected dispatch interruption');
    } catch (error: unknown) {
      if (error !== interruption) throw error;
    }
    if (
      claimed === undefined ||
      publishCalls !== 0 ||
      releaseCalls !== 0 ||
      markCalls !== 0
    )
      throw new Error(
        'Health publication was not abandoned before acknowledgment',
      );
    result = {
      outboxEventId: claimed.id,
      leaseToken: claimed.leaseToken,
      leaseOwner: claimed.leaseOwner,
      leaseExpiresAt: claimed.leaseExpiresAt.toISOString(),
      publishCalls,
      releaseCalls,
      markCalls,
    };
  } catch (error: unknown) {
    originalFailure = error;
  }
  // Closing dependencies never repairs the durable claim unknown to the dispatcher.
  const failures: unknown[] = [];
  for (const close of cleanup.toReversed()) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  abandonmentActivity = undefined;
  if (failures.length > 0)
    throw new AggregateError(
      originalFailure === undefined ? failures : [originalFailure, ...failures],
      'Abandoned owner cleanup failed',
    );
  if (originalFailure !== undefined)
    throw originalFailure instanceof Error
      ? originalFailure
      : new Error('Abandoned owner failed', { cause: originalFailure });
  if (result === undefined)
    throw new Error('Abandoned publication receipt unavailable');
  return result;
}

async function configure() {
  await namespace.acquire();
  const pending = new Promise<unknown>((resolve, reject) => {
    const cancelled = () => {
      process.off('message', configured);
      reject(new Error('Owned health configuration cancelled'));
    };
    const configured = (value: unknown) => {
      shutdown.signal.removeEventListener('abort', cancelled);
      resolve(value);
    };
    shutdown.signal.addEventListener('abort', cancelled, { once: true });
    process.once('message', configured);
    if (shutdown.signal.aborted) cancelled();
  });
  process.send?.({ phase: 'namespace-ready' });
  const config = configSchema.parse(await pending);
  return config;
}

async function construct(
  resources: EditorBrowserRuntimeConstruction,
  active: () => void,
) {
  configuration ??= await configure();
  active();
  const raw = configuration;
  const database = parseDatabaseConfig({
    connectionString: raw.workerUrl,
    max: 6,
  });
  const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
    Buffer.from(raw.connectionMasterKey, 'hex'),
    'connection',
  );
  resources.envelopeKeys = {
    close: () => {
      keys.close();
      return Promise.resolve();
    },
  };
  const capabilities = await createWorkerNodeRuntimeCapabilities(
    { database, redisUrl: namespace.redisUrl },
    { connectionEncryption: new ConnectionEnvelopeEncryption(keys) },
  );
  resources.capabilities = capabilities;
  active();
  const coordinator = await createCoordinatorRuntime({
    database,
    maximumAdmissions: 10,
    redisUrl: namespace.redisUrl,
  });
  resources.coordinator = coordinator;
  active();
  const client = createSlackClient(
    createConnectionHealthSlackTransport(raw.controlOrigin),
  );
  const attempts = await createNodeAttemptRuntime(
    {
      database,
      redisUrl: namespace.redisUrl,
      workerId: `health-${randomUUID()}`,
      heartbeatIntervalMillis: 1000,
      leaseDurationSeconds: 10,
      connectionRunHealthMode: 'enforce',
      observer: {
        handlerStarted: () =>
          process.send?.({ phase: 'health-handler-started' }),
        handlerFinished: (observation) =>
          process.send?.({
            phase: 'health-handler-finished',
            outcome: observation.outcome,
          }),
      },
    },
    {
      registry: createPlatformNodeRegistryForRelease(
        platformServingRegistryRelease(),
        {
          slackSendMessage: { client },
          httpRequest: {
            httpClient: {
              executeStreaming: () =>
                Promise.reject(new Error('HTTP outside health fixture')),
            },
          },
        },
      ),
      runtimeCapabilities: {
        ...capabilities.factories,
        artifacts: () => ({
          write: () =>
            Promise.reject(new Error('Artifacts outside health fixture')),
        }),
      },
    },
  );
  resources.attempts = attempts;
  active();
  const maintenance = healthEnabled
    ? await createMaintenanceRuntime({
        database,
        redisUrl: namespace.redisUrl,
        connectionHealthApplication: true,
        connectionRunHealthMode: 'enforce',
        previewReconciliation: false,
      })
    : undefined;
  resources.triggers = maintenance === undefined ? [] : [maintenance];
  active();
  await Promise.all([
    coordinator.consumer.waitUntilReady(5000),
    coordinator.checkReadiness(),
    attempts.consumer.waitUntilReady(5000),
    attempts.checkReadiness?.(),
    ...(maintenance === undefined
      ? []
      : [
          maintenance.consumer.waitUntilReady(5000),
          maintenance.checkReadiness(),
        ]),
  ]);
  active();
  const dispatcherDatabase = createOutboxDispatcherDatabase(
    parseDatabaseConfig({ connectionString: raw.dispatcherUrl, max: 2 }),
  );
  resources.dispatcherDatabase = dispatcherDatabase;
  const producer = createQueueProducer({ redisUrl: namespace.redisUrl });
  resources.producer = producer;
  const healthJobs =
    maintenance === undefined
      ? []
      : [JOB_NAME.applyConnectionHealthObservation];
  const dispatcher = new OutboxDispatcher(
    dispatcherDatabase,
    producer,
    resources.drain,
    {
      enabledJobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.executeNodeAttempt,
        ...healthJobs,
      ],
      batchSize: 25,
      leaseDurationMillis: PUBLICATION_LEASE_MILLIS,
      leaseOwner: `health-dispatch-${randomUUID()}`,
      maxAttempts: 10,
      operationTimeoutMillis: 5000,
      pollIntervalMillis: 50,
      retryDelayMillis: 100,
    },
    createTransportMetrics(),
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.advanceWorkflowRun, consumer: coordinator.consumer },
      { jobName: JOB_NAME.executeNodeAttempt, consumer: attempts.consumer },
      ...(maintenance === undefined
        ? []
        : [
            {
              jobName: JOB_NAME.applyConnectionHealthObservation,
              consumer: maintenance.consumer,
            },
          ]),
    ]),
  );
  resources.dispatcher = dispatcher;
  dispatcher.start();
  active();
}
try {
  await runtimeOwner.start();
  process.send({ phase: 'worker-ready' });
} catch (error: unknown) {
  process.send({
    phase: 'health-startup-failed',
    errorType: error instanceof Error ? error.name : 'unknown',
    code:
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code
        : undefined,
  });
  stop();
}
