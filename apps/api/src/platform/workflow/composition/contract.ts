import type { GovernanceStore } from '@pertexo/database/governance';

import type { DataTablesStore } from '@pertexo/database/data-tables';

import type { WorkspaceVariablesStore } from '@pertexo/database/variables';
import type { FormStore } from '@pertexo/database/triggers';

import type { PendingTaskStore } from '@pertexo/database/runs';

import type { createWorkspaceDatabase } from '@pertexo/database/platform';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import type {
  createWorkflowAuthoringDatabase,
  createWorkflowInputCaseDatabase,
} from '@pertexo/database/authoring';
import type {
  WorkflowAuthoringDatabase,
  WorkflowInputCaseDatabase,
} from '@pertexo/database/authoring';
import type {
  JsonataEvaluator,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import type { ApiIdentityRuntime } from '../../identity/runtime.module.js';
import type { ApiWorkflowMetadataRuntime } from '../metadata-runtime.js';
import type {
  LiveRunEventSource,
  RunEventNotificationPublisher,
} from '../../../workflow-runs/events/index.js';
import type { WorkflowAuthoringDependencies } from '../../../workflow-authoring/index.js';
import type { NodeTestingDependencies } from '../../../node-testing/index.js';
import type {
  createPostgresWorkflowRunPersistence,
  createWorkflowRunEventStreamer,
} from '../../../workflow-runs/index.js';
import type {
  WorkflowRunPersistence,
  WorkflowRunsDependencies,
} from '../../../workflow-runs/index.js';

export type ApiWorkflowRuntime = Readonly<{
  dependencies: WorkflowAuthoringDependencies;
  nodeTestingDependencies?: NodeTestingDependencies;
  runDependencies: WorkflowRunsDependencies;
  pendingTasks?: PendingTaskStore;
  forms?: FormStore;
  variables?: WorkspaceVariablesStore;
  dataTables?: DataTablesStore;
  governance?: GovernanceStore;
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
  streaming?: Readonly<{
    database?: WorkspaceDatabase;
    databaseFactory?: typeof createWorkspaceDatabase;
    liveSource?: LiveRunEventSource;
    liveSourceFactory?: (redisUrl: string) => LiveRunEventSource;
    streamer?: WorkflowRunsDependencies['streamer'];
    streamerFactory?: typeof createWorkflowRunEventStreamer;
  }>;
}>;

export interface WorkflowRuntimeAssembly {
  readonly database: WorkflowAuthoringDatabase;
  readonly metadataRuntime: ApiWorkflowMetadataRuntime;
  readonly pendingTasks: PendingTaskStore;
  readonly forms: FormStore;
  readonly runPersistence: WorkflowRunPersistence;
  readonly runStreamer: NonNullable<WorkflowRunsDependencies['streamer']>;
  readonly liveSource: LiveRunEventSource | undefined;
  readonly telemetry: NonNullable<WorkflowAuthoringDependencies['telemetry']>;
  readonly expressionEvaluator: JsonataEvaluator;
  readonly authoringValidator:
    Pick<WorkflowAuthoringValidator, 'validate' | 'shutdown'> | undefined;
  readonly runAdapter:
    ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined;
  readonly eventDatabase: WorkspaceDatabase | undefined;
  readonly notifications: RunEventNotificationPublisher | undefined;
  readonly identityRuntime: ApiIdentityRuntime;
}

export interface WorkflowResources {
  database: WorkflowAuthoringDatabase | undefined;
  metadataRuntime: ApiWorkflowMetadataRuntime | undefined;
  pendingTasks: PendingTaskStore | undefined;
  forms: FormStore | undefined;
  notifications: RunEventNotificationPublisher | undefined;
  runAdapter:
    ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined;
  eventDatabase: WorkspaceDatabase | undefined;
  expressionEvaluator: JsonataEvaluator | undefined;
  authoringValidator:
    Pick<WorkflowAuthoringValidator, 'validate' | 'shutdown'> | undefined;
}
