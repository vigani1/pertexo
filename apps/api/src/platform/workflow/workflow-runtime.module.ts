import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  platformServingRegistryRelease,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import {
  createWorkspaceDatabase,
  createWorkflowAuthoringDatabase,
  type DatabaseConfig,
  type WorkspaceDatabase,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database';

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
  createPostgresWorkflowRunPersistence,
  createWorkflowRunEventStreamer,
  WorkflowRunsModule,
  type WorkflowRunPersistence,
  type WorkflowRunsDependencies,
} from '../../workflow-runs/index.js';

export type ApiWorkflowRuntime = Readonly<{
  dependencies: WorkflowAuthoringDependencies;
  runDependencies: WorkflowRunsDependencies;
  close(): Promise<void>;
}>;

export type ApiWorkflowRuntimeOverrides = Readonly<{
  database?: WorkflowAuthoringDatabase;
  eventDatabase?: WorkspaceDatabase;
  liveSource?: LiveRunEventSource;
  notifications?: RunEventNotificationPublisher;
  runPersistence?: WorkflowRunPersistence;
  runStreamer?: WorkflowRunsDependencies['streamer'];
  releaseCohort?: PlatformReleaseCohort;
  telemetry?: WorkflowAuthoringDependencies['telemetry'];
}>;

function coreWorkflowCompatibility(
  releaseCohort: PlatformReleaseCohort = 'core',
) {
  const registryReleaseSupport =
    platformExecutableRegistryHistory(releaseCohort);
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    registryReleaseSupport.map(composeExecutableCompatibilityRelease),
  );
  const readinessSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const variants = registryReleaseSupport.map((nodeRelease) => {
    const compatibilityRelease =
      composeExecutableCompatibilityRelease(nodeRelease);
    const compatibilityReleaseDescription = releaseSupport.descriptions.find(
      ({ epoch, fingerprint }) =>
        epoch === compatibilityRelease.epoch &&
        fingerprint === compatibilityRelease.fingerprint,
    );
    if (compatibilityReleaseDescription === undefined)
      throw new Error('Core compatibility release description is missing');
    const definitionCatalog = Object.freeze({
      schemaVersion: 1 as const,
      releaseFingerprint: compatibilityRelease.fingerprint,
      definitions: Object.freeze(
        nodeRelease.definitions
          .filter(
            (manifest) =>
              (manifest.lifecycle === 'active' ||
                manifest.lifecycle === 'deprecated') &&
              nodeRelease.executors.some(
                (executor) =>
                  executor.lifecycle === 'active' &&
                  executor.executor.key === manifest.executor.key &&
                  executor.executor.version === manifest.executor.version,
              ),
          )
          .map(({ definition, integration, connectionRequirements }) =>
            Object.freeze({
              ...definition,
              ...(integration === undefined
                ? {}
                : {
                    integration: Object.freeze({
                      ...integration,
                      connectionSlots: Object.freeze([
                        ...connectionRequirements,
                      ]),
                    }),
                  }),
            }),
          ),
      ),
    });
    const placementDefinitionCatalog = Object.freeze({
      schemaVersion: 1 as const,
      releaseFingerprint: compatibilityRelease.fingerprint,
      definitions: Object.freeze(
        nodeRelease.definitions
          .filter(
            (manifest) =>
              manifest.lifecycle === 'active' &&
              nodeRelease.executors.some(
                (executor) =>
                  executor.lifecycle === 'active' &&
                  executor.executor.key === manifest.executor.key &&
                  executor.executor.version === manifest.executor.version,
              ),
          )
          .map(({ definition, integration, connectionRequirements }) =>
            Object.freeze({
              ...definition,
              ...(integration === undefined
                ? {}
                : {
                    integration: Object.freeze({
                      ...integration,
                      connectionSlots: Object.freeze([
                        ...connectionRequirements,
                      ]),
                    }),
                  }),
            }),
          ),
      ),
    });
    return Object.freeze({
      compatibilityRelease,
      compatibilityReleaseDescription,
      definitionCatalog,
      placementDefinitionCatalog,
    });
  });
  const latestVariant = variants.at(-1);
  if (latestVariant === undefined)
    throw new Error('Core compatibility release support is empty');
  return Object.freeze({
    releaseSupport,
    readinessSupport,
    variants: Object.freeze(variants),
    definitionCatalog: latestVariant.definitionCatalog,
  });
}

function coreAuthoringOptions(
  variants: ReturnType<typeof coreWorkflowCompatibility>['variants'],
  readinessReleases: ReturnType<
    typeof coreWorkflowCompatibility
  >['readinessSupport']['descriptions'],
) {
  return {
    compatibilityReadinessReleases: readinessReleases,
    compatibilityReleaseVariants: variants.map(
      ({
        compatibilityRelease,
        compatibilityReleaseDescription,
        definitionCatalog,
        placementDefinitionCatalog,
      }) => ({
        compatibilityRelease: compatibilityReleaseDescription,
        definitionCatalog,
        placementDefinitionCatalog,
        executableCompiler: (
          graph: Parameters<typeof buildWorkflowExecutableV2>[0]['graph'],
        ) => {
          const compiled = buildWorkflowExecutableV2({
            graph,
            release: compatibilityRelease,
          });
          return Object.freeze({
            checksum: compiled.checksum,
            executableSchemaVersion: 2 as const,
            executableJson: compiled.envelope,
            compatibilityReleaseEpoch:
              compiled.envelope.compatibilityReleaseEpoch,
            compatibilityReleaseFingerprint:
              compiled.envelope.compatibilityReleaseFingerprint,
          });
        },
      }),
    ),
  } as const;
}

export function createCoreWorkflowAuthoringDatabase(
  databaseConfig: DatabaseConfig,
  releaseCohort: PlatformReleaseCohort = 'core',
): WorkflowAuthoringDatabase {
  const compatibility = coreWorkflowCompatibility(releaseCohort);
  return createWorkflowAuthoringDatabase(
    databaseConfig,
    coreAuthoringOptions(
      compatibility.variants,
      compatibility.readinessSupport.descriptions,
    ),
  );
}

export function createApiWorkflowRuntime(
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  redisUrl: string,
  overrides: ApiWorkflowRuntimeOverrides = {},
): ApiWorkflowRuntime {
  const releaseCohort = overrides.releaseCohort ?? 'core';
  const { readinessSupport, variants, definitionCatalog } =
    coreWorkflowCompatibility(releaseCohort);
  const database =
    overrides.database ??
    createWorkflowAuthoringDatabase(
      databaseConfig,
      coreAuthoringOptions(variants, readinessSupport.descriptions),
    );
  const notifications =
    overrides.notifications ??
    (overrides.runPersistence === undefined
      ? new RedisRunEventPublisher({ redisUrl })
      : undefined);
  const runAdapter =
    overrides.runPersistence === undefined
      ? createPostgresWorkflowRunPersistence(
          databaseConfig,
          undefined,
          notifications,
          overrides.releaseCohort,
        )
      : undefined;
  const eventDatabase =
    overrides.runStreamer === undefined
      ? (overrides.eventDatabase ??
        createWorkspaceDatabase(databaseConfig, {
          compatibilityReleases: readinessSupport.descriptions,
        }))
      : undefined;
  const liveSource =
    overrides.runStreamer === undefined
      ? (overrides.liveSource ?? new RedisRunEventSource({ redisUrl }))
      : undefined;
  const runPersistence = overrides.runPersistence ?? runAdapter?.persistence;
  const runStreamer =
    overrides.runStreamer ??
    (eventDatabase === undefined || liveSource === undefined
      ? undefined
      : createWorkflowRunEventStreamer(
          createPostgresRunEventReader(eventDatabase),
          liveSource,
        ));
  if (runPersistence === undefined || runStreamer === undefined) {
    throw new Error('Workflow run runtime composition is incomplete');
  }
  const telemetry = overrides.telemetry ?? productionTelemetry();
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    dependencies: Object.freeze({
      persistence: database,
      nodeTestingPersistence: database,
      authorization: identityRuntime.dependencies.authorization,
      definitionCatalog,
      nodeTestingRelease: platformServingRegistryRelease(releaseCohort),
      telemetry,
    }),
    runDependencies: Object.freeze({
      persistence: runPersistence,
      authorization: identityRuntime.dependencies.authorization,
      streamer: runStreamer,
    }),
    close: (): Promise<void> => {
      closePromise ??= closeWorkflowResources(
        database,
        runAdapter,
        eventDatabase,
        notifications,
      );
      return closePromise;
    },
  });
}

async function closeWorkflowResources(
  authoring: WorkflowAuthoringDatabase,
  runs: ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined,
  events: WorkspaceDatabase | undefined,
  notifications: RunEventNotificationPublisher | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    authoring.close(),
    runs?.close(),
    events?.close(),
    notifications?.close(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Workflow resource shutdown failed');
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
        WorkflowRunsModule.register(runtime.runDependencies, identityModule),
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
