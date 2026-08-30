import { randomUUID } from 'node:crypto';

import {
  createDualRegionArtifactStore,
  parseDualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { parseDatabaseConfig } from '@pertexo/database';
import {
  SecureHttpClient,
  type ConnectionEnvelopeEncryption,
  type SecureHttpTransportRequest,
} from '@pertexo/integrations/server';
import { PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueProducer, QUEUE_NAME } from '@pertexo/queue';
import type { Attributes, Meter, Span, Tracer } from '@opentelemetry/api';
import { Queue } from 'bullmq';

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

export async function createHttpNodeAttemptProofRuntime(
  encryption: ConnectionEnvelopeEncryption,
) {
  const artifactConfig = parseDualRegionArtifactStoreConfig(process.env);
  const artifactVerifier = createDualRegionArtifactStore(
    artifactConfig.primary,
    artifactConfig.recovery,
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
      dispatch: (request) => {
        transportRequests.push(request);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: (async function* () {
            await Promise.resolve();
            yield new Uint8Array(35_000).fill(7);
            yield new Uint8Array(35_000).fill(9);
          })(),
          close: () => undefined,
        });
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
            if (emailRequests.length === 1)
              return {
                kind: 'rate_limited' as const,
                retryAfterMillis: 1_000,
              };
            if (emailRequests.length === 3)
              return { kind: 'invalid_response' as const };
            return {
              kind: 'succeeded',
              emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
            };
          },
        },
      },
    },
  );
  const capabilities = await createWorkerNodeRuntimeCapabilities(
    {
      artifactStore: artifactConfig,
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 3,
      }),
      redisUrl,
    },
    { connectionEncryption: encryption },
  );
  const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnection(),
  });
  const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  await Promise.all([
    attemptQueue.obliterate({ force: true }),
    coordinatorQueue.obliterate({ force: true }),
  ]);
  const coordinator = await createCoordinatorRuntime({
    database: parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 3,
    }),
    maximumAdmissions: 1,
    redisUrl,
    releaseCohort: 'email_activation',
  });
  const attempts = await createNodeAttemptRuntime(
    {
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 4,
      }),
      heartbeatIntervalMillis: 200,
      leaseDurationSeconds: 10,
      redisUrl,
      releaseCohort: 'email_activation',
      workerId: `http-attempt-${randomUUID().slice(0, 8)}`,
    },
    { registry, runtimeCapabilities: capabilities.factories },
  );
  const producer = createQueueProducer({ redisUrl });

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
}
