import {
  CoordinatorDeliveryMismatchError,
  createDueNodeWakeupScanner,
  createDeadlineWakeupScanner,
  createCoordinatorRunStore,
  createPublishedWorkflowReader,
  type CoordinatorRunStore,
  type DatabaseConfig,
  type DatabaseRuntime,
  type DueNodeWakeupScanner,
  type DeadlineWakeupScanner,
  type PublishedWorkflowReader,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  createQueueTraceRunner,
  type StructuredLogger,
} from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  JOB_NAME,
  QUEUE_NAME,
  RedisRunEventNotificationPublisher,
  type QueueConsumer,
  type QueueConsumerObserver,
  type QueueJobHandler,
  type RunEventNotificationPublisher,
  unrecoverableQueueError,
} from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import type {
  createDualRegionArtifactStore,
  ArtifactStore,
  DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';

import { createCoordinatorAdvanceEngine } from './coordinator-engine.js';
import {
  COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
  type CoordinatorValueWorkPolicy,
} from './coordinator-value-work-lifetime.js';
import type { CoordinatorNativeValueWork } from './coordinator-native-demand-advance.js';
import { createCoordinatorSourceHydration } from './coordinator-source-hydration.js';
import { createCoordinatorResultSourceHydration } from './coordinator-result-source-hydration.js';
import { parseCoordinatorRuntimeTuning } from './coordinator-runtime-tuning.js';
import {
  createCoordinatorExpressionEvaluation,
  type CoordinatorExpressionEvaluation,
} from './coordinator-expression-evaluation.js';
import type {
  ExpressionEvaluator,
  JsonataEvaluator,
} from '@pertexo/workflow-model/expressions';
import { createCoordinatorCallDeclarationHydration } from './coordinator-call-declaration-hydration.js';
import {
  createCoordinatorArtifactStorage,
  type CoordinatorArtifactStorage,
} from './coordinator-artifact-storage.js';
import { createCoordinatorResultPreparationScope } from './coordinator-result-preparation-scope.js';
import {
  createCoordinatorTelemetry,
  type CoordinatorTelemetry,
} from './coordinator-telemetry.js';
import {
  createCoordinatorHandler,
  type CoordinatorAdvanceEngine,
  type CoordinatorHandler,
  type CoordinatorCallableCompletionLoader,
  CoordinatorHandlerStateError,
} from './coordinator-handler.js';
import {
  closeCoordinatorDependencies,
  createCoordinatorRuntimeLifecycle,
} from './coordinator-runtime-lifecycle.js';

export interface CoordinatorRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export type CoordinatorRuntimeOptions = Readonly<{
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  artifactStore?: DualRegionArtifactStoreConfig;
  backgroundTaskShutdownTimeoutMillis?: number;
  dueWakeupBatchSize?: number;
  dueWakeupPollIntervalMillis?: number;
  maximumAdmissions: number;
  /** Parsed ADR065 policy, borrowed by the lazy native demand lifetime. */
  valueWorkPolicy?: CoordinatorValueWorkPolicy;
  runTimeoutFailureContextEnabled?: boolean;
  workspaceInboxProducerEnabled?: boolean;
  /** ADR 056: record schedule and webhook run outcomes for failure streaks. */
  workflowTriggerOutcomesEnabled?: boolean;
  releaseCohort?: PlatformReleaseCohort;
  observer?: QueueConsumerObserver;
  redisUrl: string;
}>;

export type CoordinatorRuntimeDependencies = Readonly<{
  clock?: Readonly<{ now(): string }>;
  consumerFactory?: typeof createQueueConsumer;
  engine?: CoordinatorAdvanceEngine;
  dueWakeupScanner?: DueNodeWakeupScanner;
  deadlineWakeupScanner?: DeadlineWakeupScanner;
  notifications?: RunEventNotificationPublisher;
  reader?: PublishedWorkflowReader;
  runStore?: CoordinatorRunStore;
  telemetry?: CoordinatorTelemetry;
  logger?: StructuredLogger;
  loadCallableCompletion?: CoordinatorCallableCompletionLoader;
  hydrateCallableSource?: CoordinatorNativeValueWork['hydrateSource'];
  /** Borrowed framework storage; never exposed to workflow executors. */
  artifactStore?: Pick<ArtifactStore, 'getStream' | 'checkReadiness'>;
  /** Borrowed existing evaluator for native paths; caller retains cleanup. */
  expressionEvaluator?: ExpressionEvaluator;
}>;

export type CoordinatorCompositionFactories = Readonly<{
  consumer: typeof createQueueConsumer;
  deadlineScanner: typeof createDeadlineWakeupScanner;
  dueScanner: typeof createDueNodeWakeupScanner;
  notifications(redisUrl: string): RunEventNotificationPublisher;
  reader: typeof createPublishedWorkflowReader;
  runStore: typeof createCoordinatorRunStore;
  telemetry: typeof createCoordinatorTelemetry;
  traceRunner: typeof createQueueTraceRunner;
  artifactStore?: typeof createDualRegionArtifactStore;
  expressionEvaluator?: () => JsonataEvaluator;
}>;

const productionFactories: CoordinatorCompositionFactories = {
  consumer: createQueueConsumer,
  deadlineScanner: createDeadlineWakeupScanner,
  dueScanner: createDueNodeWakeupScanner,
  notifications: (redisUrl) =>
    new RedisRunEventNotificationPublisher({ redisUrl }),
  reader: createPublishedWorkflowReader,
  runStore: createCoordinatorRunStore,
  telemetry: createCoordinatorTelemetry,
  traceRunner: createQueueTraceRunner,
};

function systemClock(): Readonly<{ now(): string }> {
  return Object.freeze({ now: (): string => new Date().toISOString() });
}

function queueHandler(handler: CoordinatorHandler): QueueJobHandler {
  return async (delivery, context): Promise<void> => {
    if (delivery.name !== JOB_NAME.advanceWorkflowRun) {
      throw new InvalidQueueDeliveryError(
        `Coordinator consumer cannot handle ${delivery.name}`,
      );
    }
    try {
      await handler.handle(delivery, context);
    } catch (error: unknown) {
      if (
        error instanceof CoordinatorDeliveryMismatchError ||
        error instanceof CoordinatorHandlerStateError
      ) {
        throw unrecoverableQueueError(
          error instanceof CoordinatorHandlerStateError
            ? `Coordinator delivery is not recoverable: ${error.code}`
            : 'Coordinator delivery failed durable transport verification',
        );
      }
      throw error;
    }
  };
}

export async function createCoordinatorRuntime(
  options: CoordinatorRuntimeOptions,
  dependencies: CoordinatorRuntimeDependencies = {},
  factories: CoordinatorCompositionFactories = productionFactories,
): Promise<CoordinatorRuntime> {
  if (dependencies.loadCallableCompletion !== undefined)
    throw new TypeError(
      'Unscoped coordinator material loading cannot bypass the native value lifetime',
    );
  const nativeValueWork: CoordinatorNativeValueWork = Object.freeze({
    policy: Object.freeze({
      ...(options.valueWorkPolicy ?? COORDINATOR_VALUE_WORK_POLICY_DEFAULTS),
    }),
    ...(dependencies.hydrateCallableSource === undefined
      ? {}
      : { hydrateSource: dependencies.hydrateCallableSource }),
  });
  const {
    dueWakeupBatchSize,
    dueWakeupPollIntervalMillis,
    backgroundTaskShutdownTimeoutMillis,
  } = parseCoordinatorRuntimeTuning(options);
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(options.releaseCohort ?? 'core').map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const firstRelease = releaseSupport.resolve(
    releaseSupport.descriptions[0]?.epoch ?? 0,
    releaseSupport.descriptions[0]?.fingerprint ?? '',
  );
  const currentReleaseDescriptions =
    createExecutableCompatibilityReleaseSupport(
      platformRegistryReleaseSupport(options.releaseCohort ?? 'core').map(
        composeExecutableCompatibilityRelease,
      ),
    ).descriptions;
  const telemetry = dependencies.telemetry ?? factories.telemetry();
  const traceRunner = factories.traceRunner();
  let runStore: CoordinatorRunStore | undefined;
  let reader: PublishedWorkflowReader | undefined;
  let notifications: RunEventNotificationPublisher | undefined;
  let dueWakeupScanner: DueNodeWakeupScanner | undefined;
  let deadlineWakeupScanner: DeadlineWakeupScanner | undefined;
  let consumer: QueueConsumer | undefined;
  let artifactStorage: CoordinatorArtifactStorage | undefined;
  let expressionEvaluation: CoordinatorExpressionEvaluation | undefined;
  let hydrateResultSources: ReturnType<
    typeof createCoordinatorResultSourceHydration
  >;
  const callableResultEvaluator: ExpressionEvaluator = {
    evaluate: (request) => {
      const evaluator = expressionEvaluation?.evaluator;
      if (evaluator === undefined)
        throw new Error(
          'Native coordinator expression evaluator is unavailable',
        );
      return evaluator.evaluate(request);
    },
  };
  let hydrateCallDeclaration: ReturnType<
    typeof createCoordinatorCallDeclarationHydration
  >;
  try {
    runStore =
      dependencies.runStore ??
      factories.runStore(options.database, options.databaseRuntime, {
        expectedCompatibilityReleases: currentReleaseDescriptions,
        nativeValueControlReadTimeoutMillis:
          nativeValueWork.policy.controlReadTimeoutMillis,
        withNativeResultPreparation: createCoordinatorResultPreparationScope(
          nativeValueWork.policy,
        ),
        hydrateNativeCallDeclaration: (request) =>
          hydrateCallDeclaration(request),
        hydrateNativeResultSources: (request) => hydrateResultSources(request),
        callableResultEvaluator,
        runTimeoutFailureContextEnabled:
          options.runTimeoutFailureContextEnabled ?? false,
        workspaceInboxProducerEnabled:
          options.workspaceInboxProducerEnabled ?? false,
        workflowTriggerOutcomesEnabled:
          options.workflowTriggerOutcomesEnabled ?? false,
      });
    reader =
      dependencies.reader ??
      factories.reader(
        options.database,
        currentReleaseDescriptions,
        options.databaseRuntime,
      );
    artifactStorage = createCoordinatorArtifactStorage(
      runStore,
      options.artifactStore,
      dependencies.artifactStore,
      factories.artifactStore,
    );
    hydrateCallDeclaration = createCoordinatorCallDeclarationHydration(
      runStore,
      artifactStorage.store,
      nativeValueWork.policy.controlReadTimeoutMillis,
    );
    expressionEvaluation = createCoordinatorExpressionEvaluation(
      runStore,
      dependencies.expressionEvaluator,
      factories.expressionEvaluator,
    );
    const hydrateSource =
      nativeValueWork.hydrateSource ??
      createCoordinatorSourceHydration(
        runStore,
        nativeValueWork.policy.controlReadTimeoutMillis,
        artifactStorage.store,
      );
    hydrateResultSources = createCoordinatorResultSourceHydration(runStore, {
      ...nativeValueWork,
      hydrateSource,
    });
    const engine =
      dependencies.engine ??
      createCoordinatorAdvanceEngine({
        admissionRelease: firstRelease,
        releaseSupport,
        ...(expressionEvaluation.evaluator === undefined
          ? {}
          : { expressionEvaluator: expressionEvaluation.evaluator }),
      });
    notifications =
      dependencies.notifications ?? factories.notifications(options.redisUrl);
    dueWakeupScanner =
      dependencies.dueWakeupScanner ??
      factories.dueScanner(options.database, options.databaseRuntime);
    deadlineWakeupScanner =
      dependencies.deadlineWakeupScanner ??
      factories.deadlineScanner(options.database, options.databaseRuntime);
    const handler = createCoordinatorHandler({
      clock: dependencies.clock ?? systemClock(),
      engine,
      maximumAdmissions: options.maximumAdmissions,
      notifications,
      reader,
      runStore,
      telemetry,
      nativeValueWork: {
        ...nativeValueWork,
        hydrateSource,
        hydrateCallDeclaration,
      },
    });
    await runStore.checkReadiness?.();
    await artifactStorage.checkReadiness();
    consumer = (dependencies.consumerFactory ?? factories.consumer)({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: options.redisUrl,
      handler: queueHandler(handler),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closeCoordinatorDependencies(
      {
        deadlineWakeupScanner,
        dueWakeupScanner,
        notifications,
        reader,
        runStore,
        artifactStorage,
        expressionEvaluation,
      },
      backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Coordinator runtime construction and cleanup failed',
      );
    throw error;
  }
  return createCoordinatorRuntimeLifecycle(
    {
      consumer,
      deadlineWakeupScanner,
      dueWakeupScanner,
      notifications,
      reader,
      runStore,
      artifactStorage,
      expressionEvaluation,
    },
    {
      batchSize: dueWakeupBatchSize,
      ...(dependencies.logger === undefined
        ? {}
        : { logger: dependencies.logger }),
      pollIntervalMillis: dueWakeupPollIntervalMillis,
      shutdownTimeoutMillis: backgroundTaskShutdownTimeoutMillis,
    },
  );
}
