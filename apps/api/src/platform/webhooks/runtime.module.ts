import {
  createWebhookTriggerDatabase,
  createWebhookTestEventStore,
  type WebhookTestEventStore,
  type WebhookTriggerDatabase,
} from '@pertexo/database/triggers';
import type { DatabaseRuntime } from '@pertexo/database/platform';
import { createWebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import type { ApiConfig } from '../config/api.js';
import { initialCheckpointFactory } from '@pertexo/execution';
import { WebhookTestEventService } from '../../webhooks/test-events/service.js';
import { WebhookManagementService } from '../../webhooks/management/service.js';
import type { WebhookIngressDependencies } from '../../webhooks/ingress/register.js';

export type ApiWebhookRuntime = Readonly<{
  service: WebhookManagementService;
  testService?: WebhookTestEventService;
  ingress: WebhookIngressDependencies;
  close(): Promise<void>;
}>;

type WebhookEnvelopeRuntime = ReturnType<
  typeof createWebhookTriggerEnvelopeEncryption
>;

export type ApiWebhookRuntimeFactories = Readonly<{
  database?: typeof createWebhookTriggerDatabase;
  testEvents?: typeof createWebhookTestEventStore;
  envelope?: typeof createWebhookTriggerEnvelopeEncryption;
}>;

export async function createApiWebhookRuntime(
  config: NonNullable<ApiConfig['webhooks']>,
  databaseConfig: ApiConfig['database'],
  {
    databaseOverride,
    runtime,
    factories = {},
  }: Readonly<{
    databaseOverride?: WebhookTriggerDatabase | undefined;
    runtime?: DatabaseRuntime | undefined;
    factories?: ApiWebhookRuntimeFactories | undefined;
  }> = {},
): Promise<ApiWebhookRuntime> {
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  let database: WebhookTriggerDatabase | undefined;
  let envelope: WebhookEnvelopeRuntime | undefined;
  let testEvents: WebhookTestEventStore | undefined;
  try {
    database =
      databaseOverride ??
      (factories.database ?? createWebhookTriggerDatabase)(
        databaseConfig,
        runtime,
      );
    envelope = (factories.envelope ?? createWebhookTriggerEnvelopeEncryption)(
      'mode' in config
        ? config
        : {
            keyReference: config.kmsKeyReference,
            region: config.region,
            ...(config.endpoint === undefined
              ? {}
              : { endpoint: config.endpoint }),
          },
    );
    testEvents = (factories.testEvents ?? createWebhookTestEventStore)(
      databaseConfig,
      runtime,
    );
    const acquiredTests = testEvents;
    const acquiredDatabase = database;
    const acquiredEnvelope = envelope;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      service: new WebhookManagementService(
        acquiredDatabase,
        acquiredEnvelope.encryption,
      ),
      testService: new WebhookTestEventService(
        acquiredTests,
        acquiredEnvelope.encryption,
      ),
      ingress: Object.freeze({
        testEvents: acquiredTests,
        database: acquiredDatabase,
        encryption: acquiredEnvelope.encryption,
        checkpointFactory: initialCheckpointFactory({ catalog }),
      }),
      close: () => {
        closePromise ??= closeWebhookResources(
          acquiredDatabase,
          acquiredEnvelope,
          acquiredTests,
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectWebhookCloseFailures(
      database,
      envelope,
      testEvents,
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Webhook runtime construction and cleanup failed',
      );
    throw error;
  }
}

async function closeWebhookResources(
  database: WebhookTriggerDatabase,
  envelope: WebhookEnvelopeRuntime,
  testEvents: WebhookTestEventStore,
): Promise<void> {
  const failures = await collectWebhookCloseFailures(
    database,
    envelope,
    testEvents,
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Webhook resource shutdown failed');
}

async function collectWebhookCloseFailures(
  database: WebhookTriggerDatabase | undefined,
  envelope: WebhookEnvelopeRuntime | undefined,
  testEvents: WebhookTestEventStore | undefined,
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => testEvents?.close()),
    Promise.resolve().then(() => envelope?.close()),
    Promise.resolve().then(() => database?.close()),
  ]);
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}
