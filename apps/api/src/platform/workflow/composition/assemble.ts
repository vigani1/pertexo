import type { LiveRunEventSource } from '../../../workflow-runs/events/index.js';

import type {
  ApiWorkflowRuntime,
  WorkflowRuntimeAssembly,
} from './contract.js';
import { closeWorkflowResources } from './lifecycle.js';

export function assembleWorkflowRuntime({
  database,
  metadataRuntime,
  pendingTasks,
  forms,
  runPersistence,
  runStreamer,
  liveSource,
  telemetry,
  expressionEvaluator,
  authoringValidator,
  runAdapter,
  eventDatabase,
  notifications,
  identityRuntime,
}: WorkflowRuntimeAssembly): ApiWorkflowRuntime {
  const acquiredDatabase = database;

  const acquiredMetadataRuntime = metadataRuntime;

  const acquiredPendingTasks = pendingTasks;

  const acquiredForms = forms;

  const acquiredRunAdapter = runAdapter;

  const acquiredEventDatabase = eventDatabase;

  const acquiredNotifications = notifications;

  const acquiredExpressionEvaluator = expressionEvaluator;

  const acquiredAuthoringValidator = authoringValidator;

  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    pendingTasks,
    forms,
    variables: metadataRuntime.variables,
    dataTables: metadataRuntime.dataTables,
    governance: metadataRuntime.governance,
    dependencies: Object.freeze({
      persistence: database,
      portabilityPersistence: database,
      ...(database.collaboration === undefined
        ? {}
        : { collaborationPersistence: database.collaboration }),
      ...(database.promotions === undefined
        ? {}
        : { promotionPersistence: database.promotions }),
      ...(database.publicationReviews === undefined
        ? {}
        : { publicationReviewPersistence: database.publicationReviews }),
      inputCasePersistence: metadataRuntime.inputCases,
      organization: metadataRuntime.organization,
      ...(database.errorWorkflow === undefined
        ? {}
        : { errorWorkflowPersistence: database.errorWorkflow }),
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
      expressionEvaluator,
    }),
    runDependencies: Object.freeze({
      persistence: runPersistence,
      authorization: identityRuntime.dependencies.authorization,
      streamer: runStreamer,
    }),
    checkReadiness: (): Promise<void> => {
      const readiness = liveSource as LiveRunEventSource & {
        checkReadiness?: () => Promise<void>;
      };
      return readiness.checkReadiness?.() ?? Promise.resolve();
    },
    close: (): Promise<void> => {
      closePromise ??= closeWorkflowResources(
        acquiredDatabase,
        acquiredRunAdapter,
        {
          events: acquiredEventDatabase,
          notifications: acquiredNotifications,
          expressionEvaluator: acquiredExpressionEvaluator,
          authoringValidator: acquiredAuthoringValidator,
          metadata: acquiredMetadataRuntime,
          pendingTasks: acquiredPendingTasks,
          forms: acquiredForms,
        },
      );
      return closePromise;
    },
  });
}
