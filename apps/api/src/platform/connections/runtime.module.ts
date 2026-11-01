import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createConnectionDatabase,
  type ApiConnectionDatabase,
} from '@pertexo/core/connections';
import { createFailureNotificationDestinationDatabase } from '@pertexo/core/notifications';
import {
  generatePersistedId,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  createConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createOAuth2TokenService,
  createSlackClient,
  createResendClient,
  type AllowedPrivateNetwork,
  type ConnectionEnvelopeEncryptionRuntime,
  type SecureHttpClient,
} from '@pertexo/integrations/server';

import {
  ConnectionsModule,
  createConnectionTelemetry,
  type ConnectionDependencies,
  type ConnectionTelemetry,
} from '../../connections/index.js';
import type { ApiIdentityRuntime } from '../identity/runtime.module.js';
import type { ApiConfig } from '../config/api.js';

export type ApiConnectionRuntime = Readonly<{
  dependencies: ConnectionDependencies;
  close(): Promise<void>;
}>;

export async function createApiConnectionRuntime(
  config: NonNullable<ApiConfig['connections']>,
  databaseConfig: DatabaseConfig,
  {
    identityRuntime,
    applicationSecret,
    oauth2,
    runtime,
  }: Readonly<{
    identityRuntime: ApiIdentityRuntime;
    applicationSecret: string;
    oauth2?: Readonly<{
      publicWebOrigin: string;
      allowedPrivateNetworks: readonly AllowedPrivateNetwork[];
    }>;
    runtime?: DatabaseRuntime | undefined;
  }>,
): Promise<ApiConnectionRuntime> {
  let database: ApiConnectionDatabase | undefined;
  let destinationDatabase:
    ReturnType<typeof createFailureNotificationDestinationDatabase> | undefined;
  let encryptionRuntime: ConnectionEnvelopeEncryptionRuntime | undefined;
  try {
    database = createConnectionDatabase(databaseConfig, runtime);
    destinationDatabase = createFailureNotificationDestinationDatabase(
      databaseConfig,
      runtime,
    );
    encryptionRuntime = createConnectionEnvelopeEncryption(
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
    const telemetry = productionTelemetry();
    const httpClient = createNodeSecureHttpClient();
    const slackClient = createSlackClient(httpClient);
    const emailClient = createResendClient(httpClient);
    const oauth2Runtime =
      oauth2 === undefined
        ? undefined
        : createOAuth2Runtime(oauth2, {
            database,
            encryption: encryptionRuntime.encryption,
            apiClient: httpClient,
          });
    const acquiredDatabase = database;
    const acquiredDestinationDatabase = destinationDatabase;
    const acquiredEncryptionRuntime = encryptionRuntime;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      dependencies: Object.freeze({
        applicationSecret,
        persistence: database,
        destinationPersistence: destinationDatabase,
        usagePersistence: database,
        sharingPersistence: database,
        authorization: identityRuntime.dependencies.authorization,
        encryption: encryptionRuntime.encryption,
        httpClient,
        slackClient,
        emailClient,
        telemetry,
        ...(oauth2Runtime === undefined
          ? {}
          : { oauth2: oauth2Runtime.dependencies }),
      }),
      close: (): Promise<void> => {
        // A refresh already at the service has to reach the database before it closes.
        closePromise ??= Promise.resolve(oauth2Runtime?.tokens.drain()).then(
          () =>
            closeResources(
              acquiredDatabase,
              acquiredDestinationDatabase,
              acquiredEncryptionRuntime,
            ),
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectCloseFailures(
      database,
      destinationDatabase,
      encryptionRuntime,
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Connection runtime construction and cleanup failed',
      );
    throw error;
  }
}

function createOAuth2Runtime(
  oauth2: Readonly<{
    publicWebOrigin: string;
    allowedPrivateNetworks: readonly AllowedPrivateNetwork[];
  }>,
  {
    database,
    encryption,
    apiClient,
  }: Readonly<{
    database: ApiConnectionDatabase;
    encryption: ConnectionEnvelopeEncryptionRuntime['encryption'];
    apiClient: SecureHttpClient;
  }>,
) {
  // S17: an address policy is always passed, because the transport only refuses
  // plain http to a public address when one exists. Token requests only: every
  // other request from the API keeps the public-only rule.
  const tokenClient = createNodeSecureHttpClient({
    allowedPrivateNetworks: oauth2.allowedPrivateNetworks,
  });
  const tokens = createOAuth2TokenService({
    store: database,
    encryption,
    httpClient: tokenClient,
    newId: generatePersistedId,
  });
  return Object.freeze({
    tokens,
    dependencies: Object.freeze({
      persistence: database,
      endpointPolicy: Object.freeze(oauth2),
      tokenClient,
      apiClient,
      tokens,
    }),
  });
}

async function closeResources(
  database: ApiConnectionDatabase,
  destinationDatabase: ReturnType<
    typeof createFailureNotificationDestinationDatabase
  >,
  encryption: ConnectionEnvelopeEncryptionRuntime | undefined,
): Promise<void> {
  const failures = await collectCloseFailures(
    database,
    destinationDatabase,
    encryption,
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Connection resource shutdown failed');
}

async function collectCloseFailures(
  database: ApiConnectionDatabase | undefined,
  destinationDatabase:
    ReturnType<typeof createFailureNotificationDestinationDatabase> | undefined,
  encryption: ConnectionEnvelopeEncryptionRuntime | undefined,
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => database?.close()),
    Promise.resolve().then(() => destinationDatabase?.close()),
    Promise.resolve().then(() => encryption?.close()),
  ]);
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function productionTelemetry(): ConnectionTelemetry {
  const meter = metrics.getMeter('@pertexo/api.connections', '0.0.0');
  const tracer = trace.getTracer('@pertexo/api.connections', '0.0.0');
  const count = meter.createCounter('pertexo.connection.operation.count', {
    description: 'Completed connection operations by bounded operation/outcome',
    unit: '{operation}',
  });
  const duration = meter.createHistogram(
    'pertexo.connection.operation.duration',
    {
      description: 'Connection operation duration by bounded operation/outcome',
      unit: 's',
    },
  );
  return createConnectionTelemetry({
    count: (operation, outcome) => {
      count.add(1, { operation, outcome });
    },
    duration: (operation, outcome, seconds) => {
      duration.record(seconds, { operation, outcome });
    },
    trace: (operation, work) =>
      tracer.startActiveSpan(`pertexo.${operation}`, async (span) => {
        try {
          span.setAttribute('operation', operation);
          return await work();
        } finally {
          span.end();
        }
      }),
  });
}

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ConnectionRuntimeModule {
  public static register(
    runtime: ApiConnectionRuntime,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: ConnectionRuntimeModule,
      imports: [
        ConnectionsModule.register(runtime.dependencies, identityModule),
      ],
      providers: [],
    };
  }
}
