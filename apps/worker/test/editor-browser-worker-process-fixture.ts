import { createHash, randomUUID } from 'node:crypto';
import { createOutboxDispatcherDatabase } from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createEditorControlledHttpTarget } from './support/editor-controlled-http.js';
import {
  createTriggerRuntime,
  type TriggerRuntime,
} from '../src/triggers/trigger-runtime.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { createTransportMetrics } from '@pertexo/observability/transport-metrics';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { createRedisTestNamespace } from './support/redis-test-namespace.js';
import { activateCompatibilityReleaseFixture } from './support/compatibility-release.fixture.js';
import {
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import { Pool } from 'pg';
import { EditorBrowserWorkerShutdownError } from './support/editor-browser-worker-cleanup.js';
import {
  createEditorBrowserWorkerLifetime,
  type EditorBrowserRuntimeConstruction,
} from './support/editor-browser-worker-lifetime.js';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || process.send === undefined)
  throw new Error('Owned browser worker needs Redis configuration and IPC');
const namespace = createRedisTestNamespace(
  redisUrl,
  11,
  'editor-browser-pure-core',
  {
    beforeCleanup: async () => {
      if (!process.connected || process.send === undefined)
        throw new Error('Cleanup ownership cannot be verified');
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          process.off('message', message);
          if (error === undefined) resolve();
          else reject(error);
        };
        const message = (value: unknown) => {
          if (
            typeof value !== 'object' ||
            value === null ||
            !('phase' in value)
          )
            return;
          if (value.phase === 'namespace-cleanup-approved') finish();
          else if (value.phase === 'namespace-cleanup-denied')
            finish(new Error('Cleanup ownership changed; preserve namespace'));
        };
        const timer = setTimeout(() => {
          finish(new Error('Cleanup ownership verification timed out'));
        }, 5_000);
        process.on('message', message);
        process.send?.({ phase: 'namespace-cleanup-request' });
      });
    },
  },
);
const cohort =
  process.env.EDITOR_BROWSER_CASE === 'schedule'
    ? 'schedule_activation'
    : 'validate_activation';
const controlledHttp =
  process.env.EDITOR_BROWSER_CASE === 'webhook-controlled-http';
let httpTarget: ReturnType<typeof createEditorControlledHttpTarget> | undefined;
function sendHttpEffects() {
  if (!process.connected || httpTarget === undefined) return;
  const observed = httpTarget.observe();
  try {
    process.send?.(
      {
        phase: 'controlled-http-effects',
        requests: observed.requests,
        effects: observed.effects,
        bodyHashes: observed.bodies.map((body) =>
          createHash('sha256').update(body).digest('hex'),
        ),
      },
      (error: Error | null) => {
        if (error !== null) stop();
      },
    );
  } catch {
    stop();
  }
}
const lifecycle = { stopping: false };
let configuration:
  | {
      workerUrl: string;
      dispatcherUrl: string;
      apiUrl: string;
      migrationUrl: string;
      connectionMasterKey?: string;
      authorizationValue?: string;
    }
  | undefined;
const runtimeOwner = createEditorBrowserWorkerLifetime(
  namespace,
  constructRuntimes,
);
function disconnect(): void {
  if (process.connected) process.disconnect();
}
let cancelConfiguration: (() => void) | undefined;
let finishing: Promise<void> | undefined;
function finishShutdown(setupFailure?: unknown): Promise<void> {
  finishing ??= performShutdown(setupFailure);
  return finishing;
}
async function performShutdown(setupFailure?: unknown): Promise<void> {
  const phases: string[] = setupFailure === undefined ? [] : ['startup'];
  try {
    await runtimeOwner.close();
  } catch (error) {
    phases.push(
      ...(error instanceof EditorBrowserWorkerShutdownError
        ? error.phases
        : ['shutdown']),
    );
  }
  if (phases.length > 0) process.exitCode = 1;
  sendHttpEffects();
  try {
    if (process.connected && process.send !== undefined) {
      await new Promise<void>((resolve, reject) => {
        process.send?.(
          {
            phase: 'worker-shutdown',
            success: phases.length === 0,
            failures: phases,
          },
          (error: Error | null) => {
            if (error === null) resolve();
            else reject(error);
          },
        );
      });
    }
  } catch {
    process.exitCode = 1;
  } finally {
    disconnect();
  }
}
const stop = (): void => {
  lifecycle.stopping = true;
  cancelConfiguration?.();
  // The runtime owner fences setup/restart synchronously and awaits its activity.
  void finishShutdown();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('disconnect', stop);
process.on('message', (message: unknown) => {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('phase' in message) ||
    message.phase !== 'restart-worker-runtime' ||
    !('requestId' in message) ||
    typeof message.requestId !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(message.requestId)
  )
    return;
  const requestId = message.requestId;
  const reply = (success: boolean) => {
    if (!process.connected) return;
    try {
      process.send?.(
        { phase: 'worker-runtime-restarted', requestId, success },
        (error: Error | null) => {
          if (error !== null) stop();
        },
      );
    } catch {
      stop();
    }
  };
  if (cohort !== 'schedule_activation' || lifecycle.stopping) {
    reply(false);
    return;
  }
  void Promise.resolve()
    .then(() => runtimeOwner.restart())
    .then(
      () => {
        reply(!lifecycle.stopping);
      },
      () => {
        reply(false);
        stop();
      },
    );
});

async function constructRuntimes(
  resources: EditorBrowserRuntimeConstruction,
  assertSetupActive: () => void,
): Promise<void> {
  if (configuration === undefined) {
    // Ownership is established before the parent API can write to this Redis DB.
    await namespace.acquire();
    assertSetupActive();
    const pendingConfiguration = new Promise<unknown>((resolve, reject) => {
      process.once('message', resolve);
      cancelConfiguration = () => {
        reject(new Error('Worker configuration wait canceled'));
      };
    });
    process.send?.({ phase: 'namespace-ready', database: namespace.database });
    const raw = await pendingConfiguration;
    cancelConfiguration = undefined;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('workerUrl' in raw) ||
      !('dispatcherUrl' in raw) ||
      !('apiUrl' in raw) ||
      !('migrationUrl' in raw) ||
      typeof raw.workerUrl !== 'string' ||
      typeof raw.dispatcherUrl !== 'string' ||
      typeof raw.apiUrl !== 'string' ||
      typeof raw.migrationUrl !== 'string'
    )
      throw new Error(
        'Owned browser worker database configuration is incomplete',
      );
    assertSetupActive();
    const inspector = new Pool({ connectionString: raw.migrationUrl, max: 1 });
    const readCurrent = async () => {
      const client = await inspector.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        const result = await client.query<{
          epoch: number;
          fingerprint: string;
          catalog_json: unknown;
        }>(
          `select current.epoch, current.fingerprint, release.catalog_json
          from app.node_compatibility_current current
          join app.node_compatibility_releases release
            on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
        );
        await client.query('commit');
        return result.rows[0];
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    };
    try {
      const current = await readCurrent();
      if (current === undefined)
        throw new Error('Fresh fixture compatibility pointer is missing');
      const target = platformServingRegistryRelease(cohort);
      if (current.epoch > target.epoch)
        throw new Error('Refusing fixture cohort downgrade');
      for (const release of PLATFORM_REGISTRY_RELEASE_HISTORY.filter(
        (release) =>
          release.epoch > current.epoch && release.epoch <= target.epoch,
      )) {
        assertSetupActive();
        await activateCompatibilityReleaseFixture({
          actorId: 'editor-browser-fixture',
          artifactPrefix: 'editor-browser-fixture',
          apiUrl: raw.apiUrl,
          workerUrl: raw.workerUrl,
          migrationUrl: raw.migrationUrl,
          targetRelease: release,
          readCurrent,
          reasons: {
            prepare: 'Prepare isolated pure-node browser fixture release',
            approve: 'Approve isolated pure-node browser fixture release',
            activate: 'Activate isolated pure-node browser fixture release',
          },
        });
      }
    } finally {
      await inspector.end();
    }
    configuration = {
      workerUrl: raw.workerUrl,
      dispatcherUrl: raw.dispatcherUrl,
      apiUrl: raw.apiUrl,
      migrationUrl: raw.migrationUrl,
      ...(!controlledHttp
        ? {}
        : (() => {
            if (
              !('connectionMasterKey' in raw) ||
              typeof raw.connectionMasterKey !== 'string' ||
              !/^[a-f0-9]{64}$/u.test(raw.connectionMasterKey) ||
              !('authorizationValue' in raw) ||
              typeof raw.authorizationValue !== 'string' ||
              raw.authorizationValue.length > 128
            )
              throw new Error('Owned HTTP configuration incomplete');
            return {
              connectionMasterKey: raw.connectionMasterKey,
              authorizationValue: raw.authorizationValue,
            };
          })()),
    };
  }
  const raw = configuration;
  assertSetupActive();
  const database = parseDatabaseConfig({
    connectionString: raw.workerUrl,
    max: 6,
  });
  const coordinator = await createCoordinatorRuntime({
    database,
    maximumAdmissions: 10,
    releaseCohort: cohort,
    redisUrl: namespace.redisUrl,
  });
  resources.coordinator = coordinator;
  assertSetupActive();
  let controlledCapabilities:
    Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>> | undefined;
  if (controlledHttp) {
    if (
      raw.connectionMasterKey === undefined ||
      raw.authorizationValue === undefined
    )
      throw new Error('Owned HTTP configuration incomplete');
    const master = Buffer.from(raw.connectionMasterKey, 'hex');
    const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
      master,
      'connection',
    );
    master.fill(0);
    resources.envelopeKeys = {
      close: () => {
        keys.close();
        return Promise.resolve();
      },
    };
    httpTarget = createEditorControlledHttpTarget(
      raw.authorizationValue,
      undefined,
      sendHttpEffects,
    );
    resources.controlledHttp = httpTarget;
    await httpTarget.start();
    assertSetupActive();
    controlledCapabilities = await createWorkerNodeRuntimeCapabilities(
      { database, redisUrl: namespace.redisUrl },
      { connectionEncryption: new ConnectionEnvelopeEncryption(keys) },
    );
    resources.capabilities = controlledCapabilities;
    assertSetupActive();
    await controlledCapabilities.checkReadiness();
    assertSetupActive();
  }
  const attempts = await createNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
      releaseCohort: cohort,
      redisUrl: namespace.redisUrl,
      workerId: `editor-browser-${randomUUID()}`,
    },
    {
      // These fail closed if a supposedly pure graph tries to use a provider.
      // Registry, evaluator, durable run store and execution engine remain real.
      ...(controlledCapabilities === undefined || httpTarget === undefined
        ? {
            runtimeCapabilities: {
              connections: () => ({
                resolve: () =>
                  Promise.reject(
                    new Error(
                      'Provider access is outside this pure-node fixture',
                    ),
                  ),
              }),
              artifacts: () => ({
                write: () =>
                  Promise.reject(
                    new Error('Artifacts are outside this pure-node fixture'),
                  ),
              }),
            },
          }
        : {
            registry: createPlatformNodeRegistryForRelease(
              platformServingRegistryRelease(cohort),
              {
                httpRequest: { httpClient: httpTarget.httpClient },
                // Never allow unused provider executors to fall back to real networking.
                slackSendMessage: {
                  client: {
                    sendMessage: () =>
                      Promise.reject(
                        new Error('Provider outside controlled HTTP fixture'),
                      ),
                  },
                },
                emailSendNotification: {
                  client: {
                    sendNotification: () =>
                      Promise.reject(
                        new Error('Provider outside controlled HTTP fixture'),
                      ),
                  },
                },
              },
            ),
            runtimeCapabilities: {
              ...controlledCapabilities.factories,
              artifacts: () => ({
                write: () =>
                  Promise.reject(
                    new Error('Artifacts outside inline HTTP fixture'),
                  ),
              }),
            },
          }),
    },
  );
  resources.attempts = attempts;
  assertSetupActive();
  const triggers: TriggerRuntime[] = [];
  resources.triggers = triggers;
  if (cohort === 'schedule_activation' || controlledHttp) {
    for (const scanner of cohort === 'schedule_activation'
      ? ['one', 'two']
      : ['webhook']) {
      const trigger = await createTriggerRuntime({
        database,
        redisUrl: namespace.redisUrl,
        releaseCohort: cohort,
        batchSize: 10,
        leaseDurationSeconds: 5,
        leaseOwner: `editor-schedule-${scanner}:${randomUUID()}`,
        onTimeWindowSeconds: 300,
        pollIntervalMillis: 250,
      });
      triggers.push(trigger);
      assertSetupActive();
    }
  }
  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    coordinator.checkReadiness(),
    attempts.consumer.waitUntilReady(5_000),
    attempts.checkReadiness?.(),
    ...triggers.flatMap((trigger) => [
      trigger.consumer.waitUntilReady(5_000),
      trigger.checkReadiness(),
    ]),
  ]);
  assertSetupActive();
  const dispatcherDatabase = createOutboxDispatcherDatabase(
    parseDatabaseConfig({ connectionString: raw.dispatcherUrl, max: 2 }),
  );
  resources.dispatcherDatabase = dispatcherDatabase;
  const producer = createQueueProducer({ redisUrl: namespace.redisUrl });
  resources.producer = producer;
  const dispatcher = new OutboxDispatcher(
    dispatcherDatabase,
    producer,
    resources.drain,
    {
      enabledJobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.executeNodeAttempt,
        ...(triggers.length === 0 ? [] : [JOB_NAME.reconcileWorkflowTriggers]),
      ],
      batchSize: 25,
      leaseDurationMillis: 30_000,
      leaseOwner: `browser-dispatch:${randomUUID()}`,
      maxAttempts: 10,
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 50,
      retryDelayMillis: 100,
    },
    createTransportMetrics(),
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.advanceWorkflowRun, consumer: coordinator.consumer },
      { jobName: JOB_NAME.executeNodeAttempt, consumer: attempts.consumer },
      ...(triggers[0] === undefined
        ? []
        : [
            {
              jobName: JOB_NAME.reconcileWorkflowTriggers,
              consumer: triggers[0].consumer,
            },
          ]),
    ]),
  );
  resources.dispatcher = dispatcher;
  dispatcher.start();
  assertSetupActive();
}

try {
  await runtimeOwner.start();
  if (lifecycle.stopping) throw new Error('Worker stopped during readiness');
  process.send({
    phase: 'worker-ready',
    pid: process.pid,
    cohort,
  });
} catch (error: unknown) {
  await finishShutdown(lifecycle.stopping ? undefined : error);
}
