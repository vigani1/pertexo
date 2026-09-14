import {
  createWebhookTriggerDatabase,
  type WebhookCheckpointFactory,
  type WebhookTriggerDatabase,
  type DatabaseRuntime,
} from '@pertexo/database/api';
import { createAwsWebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

import type { ApiConfig } from '../config/api-config.js';
import { createInitialWorkflowCheckpoint } from '../../executions/index.js';
import { WebhookManagementService } from '../../webhooks/service.js';
import type { WebhookIngressDependencies } from '../../webhooks/ingress.js';

export type ApiWebhookRuntime = Readonly<{
  service: WebhookManagementService;
  ingress: WebhookIngressDependencies;
  close(): Promise<void>;
}>;

type WebhookEnvelopeRuntime = ReturnType<
  typeof createAwsWebhookTriggerEnvelopeEncryption
>;

export type ApiWebhookRuntimeFactories = Readonly<{
  database?: typeof createWebhookTriggerDatabase;
  envelope?: typeof createAwsWebhookTriggerEnvelopeEncryption;
}>;

export async function createApiWebhookRuntime(
  config: NonNullable<ApiConfig['webhooks']>,
  databaseConfig: ApiConfig['database'],
  releaseCohort: PlatformReleaseCohort,
  databaseOverride?: WebhookTriggerDatabase,
  runtime?: DatabaseRuntime,
  factories: ApiWebhookRuntimeFactories = {},
): Promise<ApiWebhookRuntime> {
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const compatibility = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  let database: WebhookTriggerDatabase | undefined;
  let envelope: WebhookEnvelopeRuntime | undefined;
  try {
    database =
      databaseOverride ??
      (factories.database ?? createWebhookTriggerDatabase)(
        databaseConfig,
        compatibility.descriptions,
        runtime,
      );
    envelope = (
      factories.envelope ?? createAwsWebhookTriggerEnvelopeEncryption
    )({
      keyReference: config.kmsKeyReference,
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    });
    const acquiredDatabase = database;
    const acquiredEnvelope = envelope;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      service: new WebhookManagementService(
        acquiredDatabase,
        acquiredEnvelope.encryption,
      ),
      ingress: Object.freeze({
        database: acquiredDatabase,
        encryption: acquiredEnvelope.encryption,
        checkpointFactory: ((projection, currentRelease) =>
          createInitialWorkflowCheckpoint(
            projection,
            releaseSupport,
            currentRelease,
          )) satisfies WebhookCheckpointFactory,
      }),
      close: () => {
        closePromise ??= closeWebhookResources(
          acquiredDatabase,
          acquiredEnvelope,
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectWebhookCloseFailures(
      database,
      envelope,
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
): Promise<void> {
  const failures = await collectWebhookCloseFailures(database, envelope);
  if (failures.length > 0)
    throw new AggregateError(failures, 'Webhook resource shutdown failed');
}

async function collectWebhookCloseFailures(
  database: WebhookTriggerDatabase | undefined,
  envelope: WebhookEnvelopeRuntime | undefined,
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => envelope?.close()),
    Promise.resolve().then(() => database?.close()),
  ]);
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}
