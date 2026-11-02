import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';

export type NodeTestingPersistence = Pick<
  WorkflowAuthoringStore,
  | 'acceptPreview'
  | 'getDraft'
  | 'readPreview'
  | 'resolvePreviewReplay'
  | 'stepSamples'
  | 'workflowTests'
  | 'workflowTestSuites'
>;

export type NodeTestingDependencies = Readonly<{
  authorization: WorkspaceAuthorizationSource;
  persistence: NodeTestingPersistence;
  expressionEvaluator: ExpressionEvaluator;
}>;
