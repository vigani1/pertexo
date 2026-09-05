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
  type DatabaseRuntime,
  type WorkspaceDatabase,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database/api';

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

export type ApiWorkflowRuntime = Readonly<{
  dependencies: WorkflowAuthoringDependencies;
  nodeTestingDependencies?: NodeTestingDependencies;
  runDependencies: WorkflowRunsDependencies;
  checkReadiness?(): Promise<void>;
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

type PlatformRegistryRelease = ReturnType<
  typeof platformExecutableRegistryHistory
>[number];
type PlatformDefinitionManifest =
  PlatformRegistryRelease['definitions'][number];
type ProjectedDefinition = ReturnType<typeof projectDefinition>;

function registryIdentity(value: {
  readonly key: string;
  readonly version: number;
}): string {
  return `${value.key}\u0000${String(value.version)}`;
}

function projectDefinition(manifest: PlatformDefinitionManifest) {
  return Object.freeze({
    lifecycle: manifest.lifecycle,
    definition: Object.freeze({
      ...manifest.definition,
      ...(manifest.integration === undefined
        ? {}
        : {
            integration: Object.freeze({
              ...manifest.integration,
              connectionSlots: Object.freeze([
                ...manifest.connectionRequirements,
              ]),
            }),
          }),
    }),
  });
}

function isSupportedDefinition(definition: ProjectedDefinition): boolean {
  return (
    definition.lifecycle === 'active' || definition.lifecycle === 'deprecated'
  );
}

function isPlaceableDefinition(definition: ProjectedDefinition): boolean {
  return definition.lifecycle === 'active';
}

function projectExecutableDefinitions(
  release: PlatformRegistryRelease,
): readonly ProjectedDefinition[] {
  const activeExecutors = new Set(
    release.executors
      .filter((executor) => executor.lifecycle === 'active')
      .map((executor) => registryIdentity(executor.executor)),
  );
  return Object.freeze(
    release.definitions.flatMap((manifest) =>
      activeExecutors.has(registryIdentity(manifest.executor))
        ? [projectDefinition(manifest)]
        : [],
    ),
  );
}

function definitionCatalog(
  releaseFingerprint: string,
  definitions: readonly ProjectedDefinition[],
  include: (definition: ProjectedDefinition) => boolean,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    releaseFingerprint,
    definitions: Object.freeze(
      definitions.filter(include).map(({ definition }) => definition),
    ),
  });
}

function projectDefinitionCatalogs(
  release: PlatformRegistryRelease,
  releaseFingerprint: string,
) {
  const definitions = projectExecutableDefinitions(release);
  return Object.freeze({
    definitionCatalog: definitionCatalog(
      releaseFingerprint,
      definitions,
      isSupportedDefinition,
    ),
    placementDefinitionCatalog: definitionCatalog(
      releaseFingerprint,
      definitions,
      isPlaceableDefinition,
    ),
  });
}

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
    const { definitionCatalog, placementDefinitionCatalog } =
      projectDefinitionCatalogs(nodeRelease, compatibilityRelease.fingerprint);
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
  runtime?: DatabaseRuntime,
): WorkflowAuthoringDatabase {
  const compatibility = coreWorkflowCompatibility(releaseCohort);
  return createWorkflowAuthoringDatabase(databaseConfig, {
    ...coreAuthoringOptions(
      compatibility.variants,
      compatibility.readinessSupport.descriptions,
    ),
    ...(runtime === undefined ? {} : { runtime }),
  });
}

export function createApiWorkflowRuntime(
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  redisUrl: string,
  overrides: ApiWorkflowRuntimeOverrides = {},
  runtime?: DatabaseRuntime,
): ApiWorkflowRuntime {
  const releaseCohort = overrides.releaseCohort ?? 'core';
  const { readinessSupport, variants, definitionCatalog } =
    coreWorkflowCompatibility(releaseCohort);
  const database =
    overrides.database ??
    createWorkflowAuthoringDatabase(databaseConfig, {
      ...coreAuthoringOptions(variants, readinessSupport.descriptions),
      ...(runtime === undefined ? {} : { runtime }),
    });
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
          runtime,
        )
      : undefined;
  const eventDatabase =
    overrides.runStreamer === undefined
      ? (overrides.eventDatabase ??
        createWorkspaceDatabase(databaseConfig, {
          compatibilityReleases: readinessSupport.descriptions,
          ...(runtime === undefined ? {} : { runtime }),
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
      authorization: identityRuntime.dependencies.authorization,
      definitionCatalog,
      telemetry,
    }),
    nodeTestingDependencies: Object.freeze({
      persistence: database,
      authorization: identityRuntime.dependencies.authorization,
      release: platformServingRegistryRelease(releaseCohort),
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
      providers: [
        {
          provide: WorkflowRuntimeShutdown,
          useFactory: () => new WorkflowRuntimeShutdown(runtime),
        },
      ],
    };
  }
}
