import type { WorkspaceVariablesStore } from '@pertexo/core/variables';
import type {
  createPreviewRunStore,
  WorkflowTestStore,
  WorkflowTestSuiteStore,
} from '@pertexo/core/previews';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';

export type NodeTestingPersistence = Pick<
  WorkflowAuthoringStore,
  'getDraft' | 'stepSamples'
> &
  ReturnType<typeof createPreviewRunStore> &
  Readonly<{
    workflowTests: WorkflowTestStore;
    workflowTestSuites: WorkflowTestSuiteStore;
  }>;

export type NodeTestingDependencies = Readonly<{
  authorization: WorkspaceAuthorizationSource;
  persistence: NodeTestingPersistence;
  expressionEvaluator: ExpressionEvaluator;
  variables?: Pick<WorkspaceVariablesStore, 'read'>;
}>;
