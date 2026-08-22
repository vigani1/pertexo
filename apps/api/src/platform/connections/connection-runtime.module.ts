import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createConnectionDatabase,
  type ConnectionDatabase,
  type DatabaseConfig,
} from '@pertexo/database';
import {
  createAwsConnectionEnvelopeEncryption,
  type AwsConnectionEnvelopeEncryptionRuntime,
} from '@pertexo/integrations/server';

import {
  ConnectionsModule,
  createConnectionTelemetry,
  type ConnectionDependencies,
  type ConnectionSecretEncryptionPort,
  type ConnectionTelemetry,
} from '../../connections/index.js';
import type { ApiIdentityRuntime } from '../identity/identity-runtime.module.js';
import type { ApiConfig } from '../config/api-config.js';

export type ApiConnectionRuntime = Readonly<{
  dependencies: ConnectionDependencies;
  close(): Promise<void>;
}>;

export type ApiConnectionRuntimeOverrides = Readonly<{
  database?: ConnectionDatabase;
  encryption?: ConnectionSecretEncryptionPort;
  telemetry?: ConnectionTelemetry;
}>;

export function createApiConnectionRuntime(
  config: NonNullable<ApiConfig['connections']>,
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  overrides: ApiConnectionRuntimeOverrides = {},
): ApiConnectionRuntime {
  const database =
    overrides.database ?? createConnectionDatabase(databaseConfig);
  const encryptionRuntime =
    overrides.encryption === undefined
      ? createAwsConnectionEnvelopeEncryption({
          keyReference: config.kmsKeyReference,
          region: config.region,
          ...(config.endpoint === undefined
            ? {}
            : { endpoint: config.endpoint }),
        })
      : undefined;
  const encryption = overrides.encryption ?? encryptionRuntime?.encryption;
  if (encryption === undefined)
    throw new Error('Connection encryption composition is incomplete');
  const telemetry = overrides.telemetry ?? productionTelemetry();
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    dependencies: Object.freeze({
      persistence: database,
      authorization: identityRuntime.dependencies.authorization,
      encryption,
      telemetry,
    }),
    close: (): Promise<void> => {
      closePromise ??= closeResources(database, encryptionRuntime);
      return closePromise;
    },
  });
}

async function closeResources(
  database: ConnectionDatabase,
  encryption: AwsConnectionEnvelopeEncryptionRuntime | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    database.close(),
    Promise.resolve(encryption?.close()),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Connection resource shutdown failed');
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

class ConnectionRuntimeShutdown implements OnApplicationShutdown {
  public constructor(private readonly runtime: ApiConnectionRuntime) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.runtime.close();
  }
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
      providers: [
        {
          provide: ConnectionRuntimeShutdown,
          useFactory: () => new ConnectionRuntimeShutdown(runtime),
        },
      ],
    };
  }
}
