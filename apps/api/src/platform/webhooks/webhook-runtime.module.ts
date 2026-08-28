import {
  createWebhookTriggerDatabase,
  type WebhookCheckpointFactory,
  type WebhookTriggerDatabase,
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
import { createInitialWorkflowCheckpoint } from '../../workflow-runs/postgres-persistence.js';
import { WebhookManagementService } from '../../webhooks/service.js';
import type { WebhookIngressDependencies } from '../../webhooks/ingress.js';

export type ApiWebhookRuntime = Readonly<{
  service: WebhookManagementService;
  ingress: WebhookIngressDependencies;
  close(): Promise<void>;
}>;

export function createApiWebhookRuntime(
  config: NonNullable<ApiConfig['webhooks']>,
  databaseConfig: ApiConfig['database'],
  releaseCohort: PlatformReleaseCohort,
  databaseOverride?: WebhookTriggerDatabase,
): ApiWebhookRuntime {
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
  const database =
    databaseOverride ??
    createWebhookTriggerDatabase(databaseConfig, compatibility.descriptions);
  const envelope = createAwsWebhookTriggerEnvelopeEncryption({
    keyReference: config.kmsKeyReference,
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    service: new WebhookManagementService(database, envelope.encryption),
    ingress: Object.freeze({
      database,
      encryption: envelope.encryption,
      checkpointFactory: ((projection, currentRelease) =>
        createInitialWorkflowCheckpoint(
          projection,
          releaseSupport,
          currentRelease,
        )) satisfies WebhookCheckpointFactory,
    }),
    close: () => {
      closePromise ??= (async () => {
        envelope.close();
        await database.close();
      })();
      return closePromise;
    },
  });
}
