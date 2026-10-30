import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createConnectionDatabase,
  type ApiConnectionDatabase,
} from '@pertexo/database/connections';
import { createFailureNotificationDestinationDatabase } from '@pertexo/database/notifications';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  createConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createSlackClient,
  createResendClient,
  type ConnectionEnvelopeEncryptionRuntime,
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
    runtime,
  }: Readonly<{
    identityRuntime: ApiIdentityRuntime;
    applicationSecret: string;
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
