import type { createArtifactDestination } from '../../attempts/artifacts/http-destination.js';

import { createEditorPreview } from './previews.js';
import { createHash, randomUUID } from 'node:crypto';
import { createOutboxDispatcherDatabase } from '@pertexo/database/outbox';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import type { createCuratedTemplateQualificationTransports } from '../curated-templates/controlled-transports.js';

import type { createEditorControlledHttpTarget } from './controlled-http.js';
import type { DeliveredEmail } from './notifications/resend-mailbox.js';
import {
  createTriggerRuntime,
  type TriggerRuntime,
} from '../../../src/triggers/runtime.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import { createTransportMetrics } from '@pertexo/observability';

import { EditorBrowserWorkerShutdownError } from './cleanup.js';
import {
  createEditorBrowserWorkerLifetime,
  type EditorBrowserRuntimeConstruction,
} from './lifetime.js';
import type {
  EditorBrowserWorkerConfiguration,
  EditorBrowserWorkerState,
} from './execution/contract.js';
import {
  scheduleCase,
  errorWorkflowCase,
  webhookResponseCase,
  previewCase,
  controlledHttp,
  curatedTemplates,
  createEditorWorkerNamespace,
} from './execution/environment.js';
import { configureEditorWorker } from './execution/configuration.js';
import { startEditorCoordinator } from './execution/coordinator.js';
import { createEditorCapabilities } from './execution/capabilities.js';
import { editorAttemptDependencies } from './execution/attempt-dependencies.js';
import { testNodeAttemptRuntime } from '../runtime-factories.js';

export const redisUrl = process.env.REDIS_URL;

if (redisUrl === undefined || process.send === undefined)
  throw new Error('Owned browser worker needs Redis configuration and IPC');

export const namespace = createEditorWorkerNamespace(redisUrl);

export let artifactTarget:
  Awaited<ReturnType<typeof createArtifactDestination>> | undefined;

export let curatedTarget:
  ReturnType<typeof createCuratedTemplateQualificationTransports> | undefined;

export let httpTarget:
  ReturnType<typeof createEditorControlledHttpTarget> | undefined;

/** Hands each delivered email to the API fixture's mail-sink control listener. */
function sendEmailDeliveries(emails: readonly DeliveredEmail[]) {
  if (process.connected)
    process.send?.({ phase: 'email-deliveries', emails }, (error) => {
      if (error !== null) stop();
    });
}

export function sendHttpEffects() {
  const files = artifactTarget?.observe();
  const http = httpTarget?.observe();
  if (!process.connected || (files === undefined && http === undefined)) return;
  const message =
    files === undefined
      ? {
          phase: 'controlled-http-effects',
          requests: http?.requests,
          effects: http?.effects,
          bodyHashes: http?.bodies.map((body) =>
            createHash('sha256').update(body).digest('hex'),
          ),
        }
      : {
          phase: 'controlled-http-effects',
          requests: files.length,
          effects: files.length,
          bodyHashes: files.map((value) => value.sha256),
        };
  try {
    process.send?.(message, (error: Error | null) => {
      if (error !== null) stop();
    });
  } catch {
    stop();
  }
}

const lifecycle = { stopping: false };

export let configuration: EditorBrowserWorkerConfiguration | undefined;

const runtimeOwner = createEditorBrowserWorkerLifetime(
  namespace,
  constructRuntimes,
);

function disconnect(): void {
  if (process.connected) process.disconnect();
}

export let cancelConfiguration: (() => void) | undefined;

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
    const curatedObservation = curatedTarget?.observe();
    if (curatedObservation !== undefined && process.connected)
      await new Promise<void>((resolve, reject) => {
        process.send?.(
          { phase: 'curated-template-effects', ...curatedObservation },
          (error: Error | null) => {
            if (error === null) resolve();
            else reject(new Error('Owned curated effects unavailable'));
          },
        );
      });
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
  if (!scheduleCase || lifecycle.stopping) {
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

export const state: EditorBrowserWorkerState = {
  get configuration() {
    return configuration;
  },
  set configuration(value: typeof configuration) {
    configuration = value;
  },
  get cancelConfiguration() {
    return cancelConfiguration;
  },
  set cancelConfiguration(value: typeof cancelConfiguration) {
    cancelConfiguration = value;
  },
  get artifactTarget() {
    return artifactTarget;
  },
  set artifactTarget(value: typeof artifactTarget) {
    artifactTarget = value;
  },
  get curatedTarget() {
    return curatedTarget;
  },
  set curatedTarget(value: typeof curatedTarget) {
    curatedTarget = value;
  },
  get httpTarget() {
    return httpTarget;
  },
  set httpTarget(value: typeof httpTarget) {
    httpTarget = value;
  },
  resendMailbox: undefined,
};

async function constructRuntimes(
  resources: EditorBrowserRuntimeConstruction,
  assertSetupActive: () => void,
): Promise<void> {
  const setup = { state, namespace, resources, assertSetupActive };
  const raw = await configureEditorWorker(setup);
  assertSetupActive();
  const database = parseDatabaseConfig({
    connectionString: raw.workerUrl,
    max: 6,
  });
  const execution = {
    ...setup,
    raw,
    database,
    sendHttpEffects,
    sendEmailDeliveries,
  };
  const coordinator = await startEditorCoordinator(execution);
  const controlledCapabilities = await createEditorCapabilities(execution);
  const controlledHttpClient = (
    artifactTarget ??
    curatedTarget ??
    httpTarget ??
    state.resendMailbox
  )?.httpClient;
  const attempts = await testNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
      redisUrl: namespace.redisUrl,
      workerId: `editor-browser-${randomUUID()}`,
      ...(previewCase
        ? {
            preview: await createEditorPreview(
              database,
              controlledHttpClient === undefined
                ? undefined
                : createPlatformNodeRegistry({
                    httpRequest: { httpClient: controlledHttpClient },
                  }),
            ),
          }
        : {}),
    },
    editorAttemptDependencies({
      controlledCapabilities,
      controlledHttpClient,
      state,
    }),
  );
  resources.attempts = attempts;
  assertSetupActive();
  const triggers: TriggerRuntime[] = [];
  resources.triggers = triggers;
  if (
    scheduleCase ||
    controlledHttp ||
    curatedTemplates ||
    errorWorkflowCase ||
    webhookResponseCase
  ) {
    for (const scanner of scheduleCase ? ['one', 'two'] : ['webhook']) {
      const trigger = await createTriggerRuntime({
        database,
        redisUrl: namespace.redisUrl,
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
    attempts.checkReadiness(),
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
  const dispatcher = new OutboxDispatcher(dispatcherDatabase, producer, {
    drainState: resources.drain,
    options: {
      jobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.executeNodeAttempt,
        ...(errorWorkflowCase ? [JOB_NAME.startErrorWorkflow] : []),
        ...(previewCase ? [JOB_NAME.executePreviewAttempt] : []),
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
    metrics: createTransportMetrics(),
  });
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
  });
} catch (error: unknown) {
  await finishShutdown(lifecycle.stopping ? undefined : error);
}
