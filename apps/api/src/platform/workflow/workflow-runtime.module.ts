import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  createWorkflowAuthoringDatabase,
  type DatabaseConfig,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database';

import type { ApiIdentityRuntime } from '../identity/identity-runtime.module.js';
import {
  createWorkflowAuthoringTelemetry,
  WorkflowAuthoringModule,
  type WorkflowAuthoringDependencies,
  type WorkflowAuthoringMeter,
  type WorkflowAuthoringSpan,
  type WorkflowAuthoringTracer,
} from '../../workflow-authoring/index.js';

export type ApiWorkflowRuntime = Readonly<{
  dependencies: WorkflowAuthoringDependencies;
  close(): Promise<void>;
}>;

export type ApiWorkflowRuntimeOverrides = Readonly<{
  database?: WorkflowAuthoringDatabase;
  telemetry?: WorkflowAuthoringDependencies['telemetry'];
}>;

export function createApiWorkflowRuntime(
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  overrides: ApiWorkflowRuntimeOverrides = {},
): ApiWorkflowRuntime {
  const database =
    overrides.database ?? createWorkflowAuthoringDatabase(databaseConfig);
  const telemetry = overrides.telemetry ?? productionTelemetry();
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    dependencies: Object.freeze({
      persistence: database,
      authorization: identityRuntime.dependencies.authorization,
      telemetry,
    }),
    close: (): Promise<void> => {
      closePromise ??= database.close();
      return closePromise;
    },
  });
}

function productionTelemetry(): NonNullable<
  WorkflowAuthoringDependencies['telemetry']
> {
  const meter = metrics.getMeter('@pertexo/api.workflow-authoring', '0.0.0');
  const tracer = trace.getTracer('@pertexo/api.workflow-authoring', '0.0.0');
  const meterAdapter: WorkflowAuthoringMeter = {
    createCounter: (name, options) => {
      const counter = meter.createCounter(name, options);
      return {
        add: (value, attributes) => {
          counter.add(value, attributes);
        },
      };
    },
    createHistogram: (name, options) => {
      const histogram = meter.createHistogram(name, options);
      return {
        record: (value, attributes) => {
          histogram.record(value, attributes);
        },
      };
    },
  };
  const tracerAdapter: WorkflowAuthoringTracer = {
    startActiveSpan: (name, callback) =>
      tracer.startActiveSpan(name, (span) => callback(spanAdapter(span))),
  };
  return createWorkflowAuthoringTelemetry({
    meter: meterAdapter,
    tracer: tracerAdapter,
  });
}

function spanAdapter(
  span: Readonly<{
    setAttribute(name: string, value: string): unknown;
    end(): void;
  }>,
): WorkflowAuthoringSpan {
  return {
    setAttribute: (name, value) => {
      span.setAttribute(name, value);
    },
    end: () => {
      span.end();
    },
  };
}

class WorkflowRuntimeShutdown implements OnApplicationShutdown {
  public constructor(private readonly runtime: ApiWorkflowRuntime) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.runtime.close();
  }
}

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkflowRuntimeModule {
  public static register(
    runtime: ApiWorkflowRuntime,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: WorkflowRuntimeModule,
      imports: [
        WorkflowAuthoringModule.register(runtime.dependencies, identityModule),
      ],
      providers: [
        {
          provide: WorkflowRuntimeShutdown,
          useFactory: () => new WorkflowRuntimeShutdown(runtime),
        },
      ],
    };
  }
}
