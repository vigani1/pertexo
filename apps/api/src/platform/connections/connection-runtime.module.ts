import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createApiConnectionDatabase,
  createFailureNotificationDestinationDatabase,
  type ApiConnectionDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/api';
import {
  createAwsConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createSlackClient,
  createResendClient,
  type AwsConnectionEnvelopeEncryptionRuntime,
} from '@pertexo/integrations/server';

import {
  ConnectionsModule,
  createConnectionTelemetry,
  type ConnectionDependencies,
  type ConnectionSecretEncryptionPort,
  type ConnectionHttpClient,
  type ConnectionSlackClient,
  type ConnectionEmailClient,
  type ConnectionTelemetry,
} from '../../connections/index.js';
import type { ApiIdentityRuntime } from '../identity/identity-runtime.module.js';
import type { ApiConfig } from '../config/api-config.js';

export type ApiConnectionRuntime = Readonly<{
  dependencies: ConnectionDependencies;
  close(): Promise<void>;
}>;

export type ApiConnectionRuntimeOverrides = Readonly<{
  clients?: Readonly<{
    http?: ConnectionHttpClient;
    httpFactory?: () => ConnectionHttpClient;
    slack?: ConnectionSlackClient;
    slackFactory?: (httpClient: ConnectionHttpClient) => ConnectionSlackClient;
    email?: ConnectionEmailClient;
    emailFactory?: (httpClient: ConnectionHttpClient) => ConnectionEmailClient;
  }>;
  encryption?: Readonly<{
    value?: ConnectionSecretEncryptionPort;
    factory?: typeof createAwsConnectionEnvelopeEncryption;
  }>;
  persistence?: Readonly<{
    database?: ApiConnectionDatabase;
    databaseFactory?: typeof createApiConnectionDatabase;
    destinationDatabaseFactory?: typeof createFailureNotificationDestinationDatabase;
  }>;
  telemetry?: Readonly<{
    value?: ConnectionTelemetry;
    factory?: () => ConnectionTelemetry;
  }>;
}>;

export async function createApiConnectionRuntime(
  config: NonNullable<ApiConfig['connections']>,
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  overrides: ApiConnectionRuntimeOverrides = {},
  runtime?: DatabaseRuntime,
): Promise<ApiConnectionRuntime> {
  const persistenceOverrides = overrides.persistence ?? {};
  const encryptionOverrides = overrides.encryption ?? {};
  const clientOverrides = overrides.clients ?? {};
  const telemetryOverrides = overrides.telemetry ?? {};
  let database: ApiConnectionDatabase | undefined;
  let destinationDatabase:
    ReturnType<typeof createFailureNotificationDestinationDatabase> | undefined;
  let encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined;
  try {
    database =
      persistenceOverrides.database ??
      (persistenceOverrides.databaseFactory ?? createApiConnectionDatabase)(
        databaseConfig,
        runtime,
      );
    destinationDatabase = (
      persistenceOverrides.destinationDatabaseFactory ??
      createFailureNotificationDestinationDatabase
    )(databaseConfig, runtime);
    if (encryptionOverrides.value === undefined)
      encryptionRuntime = (
        encryptionOverrides.factory ?? createAwsConnectionEnvelopeEncryption
      )({
        keyReference: config.kmsKeyReference,
        region: config.region,
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      });
    const encryption =
      encryptionOverrides.value ?? encryptionRuntime?.encryption;
    if (encryption === undefined)
      throw new Error('Connection encryption composition is incomplete');
    const telemetry =
      telemetryOverrides.value ??
      (telemetryOverrides.factory ?? productionTelemetry)();
    const httpClient =
      clientOverrides.http ??
      (clientOverrides.httpFactory ?? createNodeSecureHttpClient)();
    const slackClient =
      clientOverrides.slack ??
      (clientOverrides.slackFactory ?? createSlackClient)(httpClient);
    const emailClient =
      clientOverrides.email ??
      (clientOverrides.emailFactory ?? createResendClient)(httpClient);
    const acquiredDatabase = database;
    const acquiredDestinationDatabase = destinationDatabase;
    const acquiredEncryptionRuntime = encryptionRuntime;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      dependencies: Object.freeze({
        persistence: database,
        destinationPersistence: destinationDatabase,
        authorization: identityRuntime.dependencies.authorization,
        encryption,
        httpClient,
        slackClient,
        emailClient,
        telemetry,
      }),
      close: (): Promise<void> => {
        closePromise ??= closeResources(
          acquiredDatabase,
          acquiredDestinationDatabase,
          acquiredEncryptionRuntime,
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

async function closeResources(
  database: ApiConnectionDatabase,
  destinationDatabase: ReturnType<
    typeof createFailureNotificationDestinationDatabase
  >,
  encryption: AwsConnectionEnvelopeEncryptionRuntime | undefined,
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
  encryption: AwsConnectionEnvelopeEncryptionRuntime | undefined,
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
