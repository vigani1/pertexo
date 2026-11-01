import { createConnectionStore } from '@pertexo/core/connections';
import { createNotificationDestinationStore } from '@pertexo/core/notifications';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  createNodeSecureHttpClient,
  createResendClient,
  createSlackClient,
} from '@pertexo/integrations/server';

import type {
  ConnectionEmailClient,
  ConnectionHttpClient,
  ConnectionSecretEncryptionPort,
  ConnectionSlackClient,
} from '../../src/connections/index.js';
import type { ApiConnectionRuntime } from '../../src/platform/connections/runtime.module.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/runtime.module.js';

/** What a fixture puts in place of KMS and the providers. */
export type FixtureConnectionServices = Readonly<{
  encryption: Readonly<{
    encryption: ConnectionSecretEncryptionPort;
    close?: () => void;
  }>;
  http?: ConnectionHttpClient;
  slack?: ConnectionSlackClient;
  email?: ConnectionEmailClient;
}>;

/** Real persistence and authorization, with the outside services replaced. */
export function createFixtureConnectionRuntime(
  databaseConfig: DatabaseConfig,
  {
    identityRuntime,
    applicationSecret,
    services,
  }: Readonly<{
    identityRuntime: ApiIdentityRuntime;
    applicationSecret: string;
    services: FixtureConnectionServices;
  }>,
): ApiConnectionRuntime {
  const database = createConnectionStore(databaseConfig);
  const destinations = createNotificationDestinationStore(databaseConfig);
  const httpClient = services.http ?? createNodeSecureHttpClient();
  return Object.freeze({
    dependencies: Object.freeze({
      applicationSecret,
      persistence: database,
      destinationPersistence: destinations,
      usagePersistence: database,
      sharingPersistence: database,
      authorization: identityRuntime.dependencies.authorization,
      encryption: services.encryption.encryption,
      httpClient,
      slackClient: services.slack ?? createSlackClient(httpClient),
      emailClient: services.email ?? createResendClient(httpClient),
      telemetry: {
        measure: <T>(_operation: string, work: () => Promise<T>): Promise<T> =>
          work(),
      },
    }),
    close: async () => {
      services.encryption.close?.();
      await Promise.all([database.close(), destinations.close()]);
    },
  });
}
