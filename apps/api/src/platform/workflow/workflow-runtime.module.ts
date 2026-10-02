import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  platformServingRegistryRelease,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  createWorkspaceDatabase,
  createWorkflowAuthoringDatabase,
  createWorkflowInputCaseDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkspaceDatabase,
  type WorkflowAuthoringDatabase,
  type WorkflowInputCaseDatabase,
} from '@pertexo/database/api';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import { WorkflowAuthoringValidator } from '@pertexo/workflow-model/authoring-validation';

import type { ApiIdentityRuntime } from '../identity/identity-runtime.module.js';
import {
  createPostgresRunEventReader,
  RedisRunEventPublisher,
  RedisRunEventSource,
  type LiveRunEventSource,
  type RunEventNotificationPublisher,
} from '../../executions/index.js';
import {
  createWorkflowAuthoringTelemetry,
  WorkflowAuthoringModule,
  type WorkflowAuthoringDependencies,
  type WorkflowAuthoringMeter,
  type WorkflowAuthoringSpan,
  type WorkflowAuthoringTracer,
} from '../../workflow-authoring/index.js';
import {
  NodeTestingModule,
  type NodeTestingDependencies,
} from '../../node-testing/index.js';
import {
  createPostgresWorkflowRunPersistence,
  createWorkflowRunEventStreamer,
  WorkflowRunsModule,
  type WorkflowRunPersistence,
  type WorkflowRunsDependencies,
} from '../../workflow-runs/index.js';
import {
  createCoreAuthoringOptions,
  createCoreWorkflowCompatibility,
} from './workflow-compatibility.js';

export { createCoreWorkflowAuthoringDatabase } from './workflow-compatibility.js';

export type ApiWorkflowRuntime = Readonly<{
  dependencies: WorkflowAuthoringDependencies;
  nodeTestingDependencies?: NodeTestingDependencies;
  runDependencies: WorkflowRunsDependencies;
  checkReadiness?(): Promise<void>;
  close(): Promise<void>;
}>;

export type ApiWorkflowRuntimeOverrides = Readonly<{
  authoring?: Readonly<{
    database?: WorkflowAuthoringDatabase;
    databaseFactory?: typeof createWorkflowAuthoringDatabase;
    inputCasePersistence?: WorkflowInputCaseDatabase;
    inputCasePersistenceFactory?: typeof createWorkflowInputCaseDatabase;
    telemetry?: WorkflowAuthoringDependencies['telemetry'];
    telemetryFactory?: () => NonNullable<
      WorkflowAuthoringDependencies['telemetry']
    >;
    expressionEvaluatorFactory?: () => JsonataEvaluator;
    authoringValidatorFactory?: () => Pick<
      WorkflowAuthoringValidator,
      'validate' | 'shutdown'
    >;
  }>;
  persistence?: Readonly<{
    notifications?: RunEventNotificationPublisher;
    notificationsFactory?: (redisUrl: string) => RunEventNotificationPublisher;
    runs?: WorkflowRunPersistence;
    runsFactory?: typeof createPostgresWorkflowRunPersistence;
  }>;
  releaseCohort?: PlatformReleaseCohort;
  streaming?: Readonly<{
    database?: WorkspaceDatabase;
    databaseFactory?: typeof createWorkspaceDatabase;
    liveSource?: LiveRunEventSource;
    liveSourceFactory?: (redisUrl: string) => LiveRunEventSource;
    streamer?: WorkflowRunsDependencies['streamer'];
    streamerFactory?: typeof createWorkflowRunEventStreamer;
  }>;
}>;

export async function createApiWorkflowRuntime(
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  redisUrl: string,
  overrides: ApiWorkflowRuntimeOverrides = {},
  runtime?: DatabaseRuntime,
): Promise<ApiWorkflowRuntime> {
  const releaseCohort = overrides.releaseCohort ?? 'core';
  const authoring = overrides.authoring ?? {};
  const persistence = overrides.persistence ?? {};
  const streaming = overrides.streaming ?? {};
  const { readinessSupport, variants } =
    createCoreWorkflowCompatibility(releaseCohort);
  let database: WorkflowAuthoringDatabase | undefined;
  let inputCaseDatabase: WorkflowInputCaseDatabase | undefined;
  let notifications: RunEventNotificationPublisher | undefined;
  let runAdapter:
    ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined;
  let eventDatabase: WorkspaceDatabase | undefined;
  let expressionEvaluator: JsonataEvaluator | undefined;
  let authoringValidator:
    Pick<WorkflowAuthoringValidator, 'validate' | 'shutdown'> | undefined;
  try {
    if (authoring.database !== undefined) {
      database = authoring.database;
    } else {
      const validator =
        authoring.authoringValidatorFactory?.() ??
        new WorkflowAuthoringValidator();
      authoringValidator = validator;
      database = (authoring.databaseFactory ?? createWorkflowAuthoringDatabase)(
        databaseConfig,
        {
          ...createCoreAuthoringOptions(
            variants,
            readinessSupport.descriptions,
            validator,
          ),
          ...(runtime === undefined ? {} : { runtime }),
        },
      );
    }
    // Test-owned authoring adapters opt into the additional feature seam explicitly.
    // Production always registers routes; the database rollout gate fails closed.
    inputCaseDatabase =
      authoring.inputCasePersistence ??
      ((authoring.database !== undefined ||
        authoring.databaseFactory !== undefined) &&
      authoring.inputCasePersistenceFactory === undefined
        ? undefined
        : (
            authoring.inputCasePersistenceFactory ??
            createWorkflowInputCaseDatabase
          )(databaseConfig, { ...(runtime === undefined ? {} : { runtime }) }));
    if (persistence.runs === undefined) {
      notifications =
        persistence.notifications ??
        (
          persistence.notificationsFactory ??
          ((url) => new RedisRunEventPublisher({ redisUrl: url }))
        )(redisUrl);
      runAdapter = (
        persistence.runsFactory ?? createPostgresWorkflowRunPersistence
      )(
        databaseConfig,
        undefined,
        notifications,
        overrides.releaseCohort,
        runtime,
      );
    }
    const runPersistence = persistence.runs ?? runAdapter?.persistence;

    let liveSource: LiveRunEventSource | undefined;
    if (streaming.streamer === undefined) {
      eventDatabase =
        streaming.database ??
        (streaming.databaseFactory ?? createWorkspaceDatabase)(databaseConfig, {
          compatibilityReleases: readinessSupport.descriptions,
          ...(runtime === undefined ? {} : { runtime }),
        });
      liveSource =
        streaming.liveSource ??
        (
          streaming.liveSourceFactory ??
          ((url) => new RedisRunEventSource({ redisUrl: url }))
        )(redisUrl);
    }
    const runStreamer =
      streaming.streamer ??
      (eventDatabase === undefined || liveSource === undefined
        ? undefined
        : (streaming.streamerFactory ?? createWorkflowRunEventStreamer)(
            createPostgresRunEventReader(eventDatabase),
            liveSource,
          ));
    if (runPersistence === undefined || runStreamer === undefined) {
      throw new Error('Workflow run runtime composition is incomplete');
    }
    const telemetry =
      authoring.telemetry ??
      (authoring.telemetryFactory ?? productionTelemetry)();
    expressionEvaluator =
      authoring.expressionEvaluatorFactory?.() ?? new JsonataEvaluator();
    const acquiredDatabase = database;
    const acquiredInputCaseDatabase = inputCaseDatabase;
    const acquiredRunAdapter = runAdapter;
    const acquiredEventDatabase = eventDatabase;
    const acquiredNotifications = notifications;
    const acquiredExpressionEvaluator = expressionEvaluator;
    const acquiredAuthoringValidator = authoringValidator;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      dependencies: Object.freeze({
        persistence: database,
        portabilityPersistence: database,
        ...(inputCaseDatabase === undefined
          ? {}
          : { inputCasePersistence: inputCaseDatabase }),
        ...(database.concurrency === undefined
          ? {}
          : { concurrencyPersistence: database.concurrency }),
        ...(database.autoPause === undefined
          ? {}
          : { autoPausePersistence: database.autoPause }),
        authorization: identityRuntime.dependencies.authorization,
        telemetry,
      }),
      nodeTestingDependencies: Object.freeze({
        persistence: database,
        authorization: identityRuntime.dependencies.authorization,
        release: platformServingRegistryRelease(releaseCohort),
        expressionEvaluator,
      }),
      runDependencies: Object.freeze({
        persistence: runPersistence,
        authorization: identityRuntime.dependencies.authorization,
        streamer: runStreamer,
      }),
      checkReadiness: (): Promise<void> => {
        if (liveSource === undefined) return Promise.resolve();
        const readiness = liveSource as LiveRunEventSource & {
          checkReadiness?: () => Promise<void>;
        };
        return readiness.checkReadiness?.() ?? Promise.resolve();
      },
      close: (): Promise<void> => {
        closePromise ??= closeWorkflowResources(
          acquiredDatabase,
          acquiredRunAdapter,
          acquiredEventDatabase,
          acquiredNotifications,
          acquiredExpressionEvaluator,
          acquiredAuthoringValidator,
          acquiredInputCaseDatabase,
        );
        return closePromise;
      },
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectWorkflowCloseFailures(
      database,
      runAdapter,
      eventDatabase,
      notifications,
      expressionEvaluator,
      authoringValidator,
      inputCaseDatabase,
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Workflow runtime construction and cleanup failed',
      );
    throw error;
  }
}

async function closeWorkflowResources(
  authoring: WorkflowAuthoringDatabase,
  runs: ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined,
  events: WorkspaceDatabase | undefined,
  notifications: RunEventNotificationPublisher | undefined,
  expressionEvaluator: JsonataEvaluator,
  authoringValidator: Pick<WorkflowAuthoringValidator, 'shutdown'> | undefined,
  inputCases: WorkflowInputCaseDatabase | undefined,
): Promise<void> {
  const failures = await collectWorkflowCloseFailures(
    authoring,
    runs,
    events,
    notifications,
    expressionEvaluator,
    authoringValidator,
    inputCases,
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Workflow resource shutdown failed');
}

async function collectWorkflowCloseFailures(
  authoring: WorkflowAuthoringDatabase | undefined,
  runs: ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined,
  events: WorkspaceDatabase | undefined,
  notifications: RunEventNotificationPublisher | undefined,
  expressionEvaluator: JsonataEvaluator | undefined,
  authoringValidator: Pick<WorkflowAuthoringValidator, 'shutdown'> | undefined,
  inputCases: WorkflowInputCaseDatabase | undefined,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await authoringValidator?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  const results = await Promise.allSettled([
    Promise.resolve().then(() => authoring?.close()),
    Promise.resolve().then(() => inputCases?.close()),
    Promise.resolve().then(() => runs?.close()),
    Promise.resolve().then(() => events?.close()),
    Promise.resolve().then(() => notifications?.close()),
    Promise.resolve().then(() => expressionEvaluator?.shutdown()),
  ]);
  return [
    ...failures,
    ...results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    ),
  ];
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
        ...(runtime.nodeTestingDependencies === undefined
          ? []
          : [
              NodeTestingModule.register(
                runtime.nodeTestingDependencies,
                identityModule,
              ),
            ]),
        WorkflowRunsModule.register(runtime.runDependencies, identityModule),
      ],
      providers: [],
    };
  }
}
