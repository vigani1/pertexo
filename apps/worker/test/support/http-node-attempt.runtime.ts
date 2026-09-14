import { randomUUID } from 'node:crypto';

import {
  createDualRegionArtifactStore,
  parseDualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  createNodeAttemptRunStore,
  createWorkerConnectionResolutionDatabase,
  type NodeAttemptRunStore,
  type WorkerConnectionResolutionDatabase,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  SecureHttpClient,
  type ConnectionEnvelopeEncryption,
  type ResendClient,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
  type SlackClient,
} from '@pertexo/integrations/server';
import { PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import type { NodeConnectionRuntime } from '@pertexo/node-sdk/server';
import { createQueueProducer, QUEUE_NAME } from '@pertexo/queue';
import type { Attributes, Meter, Span, Tracer } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';

import { createCoordinatorRuntime } from '../../src/execution/coordinator-runtime.js';
import { createProductionHttpProviderTelemetry } from '../../src/execution/http-provider-telemetry.js';
import { createNodeAttemptRuntime } from '../../src/execution/node-attempt-runtime.js';
import { createWorkerNodeRuntimeCapabilities } from '../../src/execution/node-runtime-capabilities.js';
import {
  databaseUrl,
  redisConnection,
  redisUrl,
  workerUrl,
} from './http-node-attempt.fixture.js';

type ConnectionAssertCurrentInput = Parameters<
  NonNullable<NodeConnectionRuntime['assertCurrent']>
>[0];

export type HttpNodeAttemptProofRuntimeOptions = Readonly<{
  afterConnectionAssertCurrent?: (
    input: Omit<ConnectionAssertCurrentInput, 'signal'>,
  ) => Promise<void>;
  afterAttemptClaimed?: (
    result: Awaited<ReturnType<NodeAttemptRunStore['claimDelivery']>>,
  ) => Promise<void>;
  afterHeartbeat?: (
    result: Awaited<ReturnType<NodeAttemptRunStore['heartbeat']>>,
  ) => Promise<void>;
  beforeHeartbeat?: (
    input: Parameters<NodeAttemptRunStore['heartbeat']>[0],
  ) => Promise<void>;
  beforeConnectionResolve?: (
    input: Parameters<
      WorkerConnectionResolutionDatabase['resolveConnectionSecret']
    >[0],
  ) => Promise<void>;
  beforeMarkDispatched?: (
    input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
  ) => Promise<void>;
  beforeRegistryExecute?: (
    request: Parameters<NodeExecutionRegistry['execute']>[0],
  ) => Promise<void>;
  dispatchHttp?: (
    request: SecureHttpTransportRequest,
  ) => Promise<SecureHttpTransportResponse>;
  emailResponseScript?: readonly Awaited<
    ReturnType<ResendClient['sendNotification']>
  >[];
  sendSlackMessage?: SlackClient['sendMessage'];
  sendEmailNotification?: ResendClient['sendNotification'];
  heartbeatIntervalMillis?: number;
  leaseDurationSeconds?: number;
}>;

export async function createHttpNodeAttemptProofRuntime(
  encryption: ConnectionEnvelopeEncryption,
  options: HttpNodeAttemptProofRuntimeOptions = {},
) {
  const owners: {
    close: () => unknown;
    label: string;
    resource: object;
  }[] = [];
  const own = <Resource extends object>(
    label: string,
    resource: Resource,
    close: (resource: Resource) => unknown,
  ): Resource => {
    let closePromise: Promise<void> | undefined;
    owners.push({
      label,
      resource,
      close: () => {
        closePromise ??= Promise.resolve()
          .then(() => close(resource))
          .then(() => undefined);
        return closePromise;
      },
    });
    return resource;
  };
  const transfer = (resource: object): void => {
    const index = owners.findIndex((owner) => owner.resource === resource);
    if (index === -1)
      throw new Error('HTTP attempt proof runtime owner is missing');
    owners.splice(index, 1);
  };
  try {
    const artifactConfig = parseDualRegionArtifactStoreConfig(process.env);
    const artifactVerifier = own(
      'artifact verifier',
      createDualRegionArtifactStore(
        artifactConfig.primary,
        artifactConfig.recovery,
      ),
      (verifier) => {
        verifier.close();
      },
    );
    const transportRequests: SecureHttpTransportRequest[] = [];
    const slackRequests: {
      botToken: string;
      channelId: string;
      text: string;
    }[] = [];
    const emailRequests: {
      apiKey: string;
      fromEmail: string;
      toEmail: string;
      subject: string;
      text: string;
      idempotencyKey: string;
    }[] = [];
    const telemetry: {
      kind: 'count' | 'duration' | 'span';
      name: string;
      attributes?: Attributes;
    }[] = [];
    const meter = {
      createCounter: (name: string) => ({
        add: (_value: number, attributes?: Attributes) =>
          telemetry.push({
            kind: 'count',
            name,
            ...(attributes === undefined ? {} : { attributes }),
          }),
      }),
      createHistogram: (name: string) => ({
        record: (_value: number, attributes?: Attributes) =>
          telemetry.push({
            kind: 'duration',
            name,
            ...(attributes === undefined ? {} : { attributes }),
          }),
      }),
    } as unknown as Meter;
    const tracer = {
      startActiveSpan: async <T>(
        name: string,
        work: (span: Span) => Promise<T>,
      ): Promise<T> => {
        const attributes: Attributes = {};
        const span = {
          setAttribute: (key: string, value: unknown) => {
            attributes[key] = value as never;
            return span;
          },
          setStatus: () => span,
          end: () => telemetry.push({ kind: 'span', name, attributes }),
        } as unknown as Span;
        return work(span);
      },
    } as unknown as Tracer;
    const httpClient = new SecureHttpClient(
      {
        resolve: () =>
          Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
      },
      {
        dispatch: async (request) => {
          transportRequests.push(request);
          if (options.dispatchHttp !== undefined)
            return options.dispatchHttp(request);
          return {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            body: (async function* () {
              await Promise.resolve();
              yield new Uint8Array(35_000).fill(7);
              yield new Uint8Array(35_000).fill(9);
            })(),
            close: () => undefined,
          };
        },
      },
    );
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
      {
        httpRequest: { httpClient },
        httpRequestTelemetry: createProductionHttpProviderTelemetry({
          meter,
          tracer,
        }),
        slackSendMessage: {
          client: {
            sendMessage: async (input) => {
              await input.beforeDispatch();
              slackRequests.push({
                botToken: input.botToken,
                channelId: input.channelId,
                text: input.text,
              });
              if (options.sendSlackMessage !== undefined)
                return options.sendSlackMessage({
                  ...input,
                  beforeDispatch: () => Promise.resolve(),
                });
              return {
                kind: 'succeeded',
                channelId: input.channelId,
                messageTs: '1724412345.000100',
              };
            },
          },
        },
        emailSendNotification: {
          client: {
            sendNotification: async (input) => {
              await input.beforeDispatch();
              emailRequests.push({
                apiKey: input.apiKey,
                fromEmail: input.fromEmail,
                toEmail: input.toEmail,
                subject: input.subject,
                text: input.text,
                idempotencyKey: input.idempotencyKey,
              });
              if (options.sendEmailNotification !== undefined)
                return options.sendEmailNotification({
                  ...input,
                  beforeDispatch: () => Promise.resolve(),
                });
              const scripted =
                options.emailResponseScript?.[emailRequests.length - 1];
              if (scripted !== undefined) return scripted;
              if (
                options.emailResponseScript !== undefined &&
                emailRequests.length > options.emailResponseScript.length
              )
                throw new Error('Email response script was exhausted');
              return {
                kind: 'succeeded',
                emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
              };
            },
          },
        },
      },
    );
    const executionRegistry: NodeExecutionRegistry =
      options.beforeRegistryExecute === undefined
        ? registry
        : Object.freeze({
            dispatchMode: registry.dispatchMode,
            execute: async (
              request: Parameters<NodeExecutionRegistry['execute']>[0],
            ) => {
              await options.beforeRegistryExecute?.(request);
              return registry.execute(request);
            },
          });
    let injectedConnectionDatabase:
      WorkerConnectionResolutionDatabase | undefined;
    if (
      options.afterConnectionAssertCurrent !== undefined ||
      options.beforeConnectionResolve !== undefined
    ) {
      const baseConnectionDatabase = own(
        'connection database',
        createWorkerConnectionResolutionDatabase(
          parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 3,
          }),
        ),
        (database) => database.close(),
      );
      injectedConnectionDatabase = Object.freeze({
        assertConnectionSecretCurrent: async (
          input: Parameters<
            WorkerConnectionResolutionDatabase['assertConnectionSecretCurrent']
          >[0],
        ): Promise<void> => {
          await baseConnectionDatabase.assertConnectionSecretCurrent(input);
          await options.afterConnectionAssertCurrent?.(input);
        },
        resolveConnectionSecret: async (input) => {
          await options.beforeConnectionResolve?.(input);
          return baseConnectionDatabase.resolveConnectionSecret(input);
        },
        close: baseConnectionDatabase.close,
      });
      transfer(baseConnectionDatabase);
      own('connection database', injectedConnectionDatabase, (database) =>
        database.close(),
      );
    }
    let capabilities = own(
      'node runtime capabilities',
      await createWorkerNodeRuntimeCapabilities(
        {
          artifactStore: artifactConfig,
          database: parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 3,
          }),
          redisUrl,
        },
        {
          connectionEncryption: encryption,
          ...(injectedConnectionDatabase === undefined
            ? {}
            : { connectionDatabase: injectedConnectionDatabase }),
        },
      ),
      (runtime) => runtime.close(),
    );
    if (injectedConnectionDatabase !== undefined) {
      const ownedConnectionDatabase = injectedConnectionDatabase;
      const unwrappedCapabilities = capabilities;
      const closeCapabilities = capabilities.close;
      transfer(unwrappedCapabilities);
      transfer(ownedConnectionDatabase);
      let closePromise: Promise<void> | undefined;
      capabilities = Object.freeze({
        ...capabilities,
        close: (): Promise<void> => {
          closePromise ??= (async () => {
            const errors: unknown[] = [];
            await closeCapabilities().catch((error: unknown) =>
              errors.push(error),
            );
            await ownedConnectionDatabase
              .close()
              .catch((error: unknown) => errors.push(error));
            if (errors.length > 0)
              throw new AggregateError(
                errors,
                'HTTP attempt capabilities cleanup failed',
              );
          })();
          return closePromise;
        },
      });
      own('node runtime capabilities', capabilities, (runtime) =>
        runtime.close(),
      );
    }
    const attemptQueue = own(
      'node attempt queue',
      new Queue(QUEUE_NAME.nodeAttempts, {
        connection: redisConnection(),
      }),
      (queue) => queue.close(),
    );
    const coordinatorQueue = own(
      'workflow coordinator queue',
      new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      }),
      (queue) => queue.close(),
    );
    await Promise.all([
      attemptQueue.obliterate({ force: true }),
      coordinatorQueue.obliterate({ force: true }),
    ]);
    const coordinator = own(
      'coordinator runtime',
      await createCoordinatorRuntime({
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 3,
        }),
        maximumAdmissions: 1,
        redisUrl,
        releaseCohort: 'email_activation',
      }),
      (runtime) => runtime.close(),
    );
    let injectedRunStore: NodeAttemptRunStore | undefined;
    if (
      options.afterAttemptClaimed !== undefined ||
      options.afterHeartbeat !== undefined ||
      options.beforeHeartbeat !== undefined ||
      options.beforeMarkDispatched !== undefined
    ) {
      const baseRunStore = own(
        'node attempt run store',
        createNodeAttemptRunStore(
          parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
            max: 4,
          }),
        ),
        (store) => store.close(),
      );
      injectedRunStore = Object.freeze({
        claimDelivery: async (
          input: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
        ) => {
          const result = await baseRunStore.claimDelivery(input);
          await options.afterAttemptClaimed?.(result);
          return result;
        },
        loadInputs: (input: Parameters<NodeAttemptRunStore['loadInputs']>[0]) =>
          baseRunStore.loadInputs(input),
        markDispatched: async (
          input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
        ) => {
          await options.beforeMarkDispatched?.(input);
          return baseRunStore.markDispatched(input);
        },
        heartbeat: async (
          input: Parameters<NodeAttemptRunStore['heartbeat']>[0],
        ) => {
          await options.beforeHeartbeat?.(input);
          const result = await baseRunStore.heartbeat(input);
          await options.afterHeartbeat?.(result);
          return result;
        },
        complete: (input: Parameters<NodeAttemptRunStore['complete']>[0]) =>
          baseRunStore.complete(input),
        close: () => baseRunStore.close(),
      });
      transfer(baseRunStore);
      own('node attempt run store', injectedRunStore, (store) => store.close());
    }
    const attemptsPromise = createNodeAttemptRuntime(
      {
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 4,
        }),
        heartbeatIntervalMillis: options.heartbeatIntervalMillis ?? 200,
        leaseDurationSeconds: options.leaseDurationSeconds ?? 10,
        redisUrl,
        releaseCohort: 'email_activation',
        workerId: `http-attempt-${randomUUID().slice(0, 8)}`,
      },
      {
        registry: executionRegistry,
        runtimeCapabilities: capabilities.factories,
        ...(injectedRunStore === undefined
          ? {}
          : { runStore: injectedRunStore }),
      },
    );
    if (injectedRunStore !== undefined) transfer(injectedRunStore);
    const attempts = own(
      'node attempt runtime',
      await attemptsPromise,
      (runtime) => runtime.close(),
    );
    const producer = own(
      'queue producer',
      createQueueProducer({ redisUrl }),
      (queueProducer) => queueProducer.close(),
    );

    return {
      artifactVerifier,
      attemptQueue,
      attempts,
      capabilities,
      coordinator,
      coordinatorQueue,
      emailRequests,
      producer,
      slackRequests,
      telemetry,
      transportRequests,
    };
  } catch (startupError: unknown) {
    const errors: unknown[] = [startupError];
    for (const owner of owners.reverse())
      await Promise.resolve()
        .then(owner.close)
        .catch((error: unknown) => errors.push(error));
    if (errors.length === 1) throw startupError;
    throw new AggregateError(
      errors,
      'HTTP attempt proof runtime startup failed',
    );
  }
}
