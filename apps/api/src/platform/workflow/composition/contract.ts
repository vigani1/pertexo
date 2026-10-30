import type { GovernanceStore } from '@pertexo/database/governance';

import type { DataTablesStore } from '@pertexo/database/data-tables';

import type { WorkspaceVariablesStore } from '@pertexo/database/variables';
import type { FormStore } from '@pertexo/database/triggers';

import type { PendingTaskStore } from '@pertexo/database/runs';

import type { WorkspaceDatabase } from '@pertexo/database/platform';
import type { WorkflowAuthoringDatabase } from '@pertexo/database/authoring';
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
import type { createPostgresWorkflowRunPersistence } from '../../../workflow-runs/index.js';
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

export interface WorkflowRuntimeAssembly {
  readonly database: WorkflowAuthoringDatabase;
  readonly metadataRuntime: ApiWorkflowMetadataRuntime;
  readonly pendingTasks: PendingTaskStore;
  readonly forms: FormStore;
  readonly runPersistence: WorkflowRunPersistence;
  readonly runStreamer: NonNullable<WorkflowRunsDependencies['streamer']>;
  readonly liveSource: LiveRunEventSource;
  readonly telemetry: NonNullable<WorkflowAuthoringDependencies['telemetry']>;
  readonly expressionEvaluator: JsonataEvaluator;
  readonly authoringValidator: Pick<
    WorkflowAuthoringValidator,
    'validate' | 'shutdown'
  >;
  readonly runAdapter: ReturnType<typeof createPostgresWorkflowRunPersistence>;
  readonly eventDatabase: WorkspaceDatabase;
  readonly notifications: RunEventNotificationPublisher;
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
