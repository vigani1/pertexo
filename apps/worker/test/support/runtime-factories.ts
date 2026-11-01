import type { WorkflowExecutionReader } from '@pertexo/core/runs';
import type { RunEventNotificationPublisher } from '@pertexo/queue';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';

import {
  createNodeAttemptRuntime,
  type NodeAttemptRuntimeFactories,
  type NodeAttemptRuntimeOptions,
} from '../../src/attempts/delivery/runtime.js';
import { unknownOutcomeReconciliationFactories } from '../../src/attempts/delivery/unknown-outcome-reconciliation.js';
import type { NodeExecutionCapabilityFactories } from '../../src/attempts/execution/capabilities.js';
import { connectionHealthObservationFactories } from '../../src/connections/health-runtime.js';
import {
  createMaintenanceRuntime,
  type MaintenanceRuntimeFactories,
} from '../../src/maintenance/runtime.js';
import { errorWorkflowFactories } from '../../src/notifications/error-workflow.js';
import { failureNotificationFactories } from '../../src/notifications/failure-composition.js';
import { operatorRunReplayFactories } from '../../src/operator/run-replay.js';
import { previewReconciliationFactories } from '../../src/previews/reconciliation.js';
import type { PreviewTelemetry } from '../../src/previews/telemetry.js';
import {
  createCoordinatorRuntime,
  type CoordinatorCompositionFactories,
  type CoordinatorRuntimeOptions,
} from '../../src/runs/runtime.js';
import {
  createTriggerRuntime,
  type TriggerCompositionFactories,
  type TriggerRuntimeOptions,
} from '../../src/triggers/runtime.js';

type FactoryValue<Factory> = Factory extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

/** Drops the services a test left out, so the production factories remain. */
function supplied<T extends object>(services: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(services).filter(([, service]) => service !== undefined),
  ) as Partial<T>;
}

function returning<Value>(value: Value | undefined) {
  return value === undefined ? undefined : () => value;
}

export type TestCoordinatorServices = Readonly<{
  advance?: FactoryValue<CoordinatorCompositionFactories['advance']>;
  consumerFactory?: CoordinatorCompositionFactories['consumer'];
  dueWakeupScanner?: FactoryValue<
    CoordinatorCompositionFactories['dueScanner']
  >;
  testSuiteScanner?: FactoryValue<
    CoordinatorCompositionFactories['testSuiteScanner']
  >;
  deadlineWakeupScanner?: FactoryValue<
    CoordinatorCompositionFactories['deadlineScanner']
  >;
  notifications?: FactoryValue<
    CoordinatorCompositionFactories['notifications']
  >;
  runStore?: FactoryValue<CoordinatorCompositionFactories['runStore']>;
  callStore?: FactoryValue<CoordinatorCompositionFactories['callStore']>;
  logger?: CoordinatorRuntimeOptions['logger'];
}>;

/** The real coordinator runtime, with the named outside services replaced. */
export function testCoordinatorRuntime(
  options: CoordinatorRuntimeOptions,
  services: TestCoordinatorServices = {},
  factories: Partial<CoordinatorCompositionFactories> = {},
) {
  const { logger } = services;
  return createCoordinatorRuntime(
    { ...options, ...(logger === undefined ? {} : { logger }) },
    {
      ...factories,
      ...supplied({
        advance: returning(services.advance),
        consumer: services.consumerFactory,
        dueScanner: returning(services.dueWakeupScanner),
        testSuiteScanner:
          services.testSuiteScanner === undefined
            ? undefined
            : () => Promise.resolve(services.testSuiteScanner as never),
        deadlineScanner: returning(services.deadlineWakeupScanner),
        notifications: returning(services.notifications),
        runStore: returning(services.runStore),
        callStore: returning(services.callStore),
      }),
    } as Partial<CoordinatorCompositionFactories>,
  );
}

export type TestTriggerServices = Readonly<{
  checkpointFactory?: FactoryValue<TriggerCompositionFactories['checkpoints']>;
  consumerFactory?: TriggerCompositionFactories['consumer'];
  reconciliation?: FactoryValue<TriggerCompositionFactories['reconciliation']>;
  scanner?: FactoryValue<TriggerCompositionFactories['scanner']>;
  coordination?: FactoryValue<TriggerCompositionFactories['coordination']>;
  telemetry?: FactoryValue<TriggerCompositionFactories['telemetry']>;
  logger?: TriggerRuntimeOptions['logger'];
}>;

/** The real trigger runtime, with the named outside services replaced. */
export function testTriggerRuntime(
  options: TriggerRuntimeOptions,
  services: TestTriggerServices = {},
  factories: Partial<TriggerCompositionFactories> = {},
) {
  const { logger } = services;
  return createTriggerRuntime(
    { ...options, ...(logger === undefined ? {} : { logger }) },
    {
      ...factories,
      ...supplied({
        checkpoints: returning(services.checkpointFactory),
        consumer: services.consumerFactory,
        reconciliation: returning(services.reconciliation),
        scanner: returning(services.scanner),
        coordination: returning(services.coordination),
        telemetry: returning(services.telemetry),
      }),
    } as Partial<TriggerCompositionFactories>,
  );
}

export type TestMaintenanceServices = Readonly<{
  connectionHealthStore?: FactoryValue<
    MaintenanceRuntimeFactories['connectionHealth']['store']
  >;
  errorWorkflowStore?: FactoryValue<
    MaintenanceRuntimeFactories['errorWorkflows']['store']
  >;
  consumerFactory?: MaintenanceRuntimeFactories['consumer'];
  reconciliationStore?: FactoryValue<
    MaintenanceRuntimeFactories['preview']['store']
  >;
  previewTelemetry?: PreviewTelemetry;
  failureNotificationStore?: FactoryValue<
    MaintenanceRuntimeFactories['notifications']['store']
  >;
  unknownOutcomeStore?: FactoryValue<
    MaintenanceRuntimeFactories['unknownOutcome']['store']
  >;
  runReplayStore?: FactoryValue<MaintenanceRuntimeFactories['replay']['store']>;
}>;

/** The real maintenance runtime, with the named outside services replaced. */
export function testMaintenanceRuntime(
  options: Parameters<typeof createMaintenanceRuntime>[0],
  services: TestMaintenanceServices = {},
  factories: Partial<MaintenanceRuntimeFactories> = {},
) {
  const preview = factories.preview ?? previewReconciliationFactories;
  return createMaintenanceRuntime(options, {
    ...factories,
    ...(services.consumerFactory === undefined
      ? {}
      : { consumer: services.consumerFactory }),
    connectionHealth: {
      ...(factories.connectionHealth ?? connectionHealthObservationFactories),
      ...supplied({ store: returning(services.connectionHealthStore) }),
    },
    errorWorkflows: {
      ...(factories.errorWorkflows ?? errorWorkflowFactories),
      ...supplied({ store: returning(services.errorWorkflowStore) }),
    },
    preview: {
      ...preview,
      ...supplied({ store: returning(services.reconciliationStore) }),
      handler: (store) => preview.handler(store, services.previewTelemetry),
    },
    notifications: {
      ...(factories.notifications ?? failureNotificationFactories),
      ...supplied({ store: returning(services.failureNotificationStore) }),
    },
    unknownOutcome: {
      ...(factories.unknownOutcome ?? unknownOutcomeReconciliationFactories),
      ...supplied({ store: returning(services.unknownOutcomeStore) }),
    },
    replay: {
      ...(factories.replay ?? operatorRunReplayFactories),
      ...supplied({ store: returning(services.runReplayStore) }),
    },
  } as Partial<MaintenanceRuntimeFactories>);
}

export type TestNodeAttemptServices = Readonly<{
  capabilityFactory?: NodeAttemptRuntimeFactories['capabilities'];
  consumerFactory?: NodeAttemptRuntimeFactories['consumer'];
  engine?: FactoryValue<NodeAttemptRuntimeFactories['engine']>;
  notifications?: RunEventNotificationPublisher;
  reader?: WorkflowExecutionReader;
  registry?: NodeExecutionRegistry;
  runStore?: FactoryValue<NodeAttemptRuntimeFactories['runStore']>;
  /** Borrowed: the test owns whatever stands behind these. */
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
  previewTelemetry?: PreviewTelemetry;
  previewHandlerFactory?: NodeAttemptRuntimeFactories['previewHandler'];
}>;

/** The real node-attempt runtime, with the named outside services replaced. */
export function testNodeAttemptRuntime(
  options: NodeAttemptRuntimeOptions,
  services: TestNodeAttemptServices = {},
) {
  const { runtimeCapabilities } = services;
  return createNodeAttemptRuntime(
    options,
    supplied({
      capabilities:
        services.capabilityFactory ??
        (runtimeCapabilities === undefined
          ? undefined
          : () =>
              Promise.resolve({
                factories: runtimeCapabilities,
                checkReadiness: () => Promise.resolve(),
                close: () => Promise.resolve(),
              })),
      consumer: services.consumerFactory,
      engine: returning(services.engine),
      notifications: returning(services.notifications),
      reader: returning(services.reader),
      registry: returning(services.registry),
      runStore: returning(services.runStore),
      previewTelemetry: returning(services.previewTelemetry),
      previewHandler: services.previewHandlerFactory,
    }) as Partial<NodeAttemptRuntimeFactories>,
  );
}
