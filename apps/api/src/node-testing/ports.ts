import type { WorkflowAuthoringDatabase } from '@pertexo/database/authoring';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';

export type NodeTestingPersistence = Pick<
  WorkflowAuthoringDatabase,
  'acceptPreview' | 'getDraft' | 'readPreview' | 'resolvePreviewReplay'
>;

export type NodeTestingDependencies = Readonly<{
  authorization: WorkspaceAuthorizationSource;
  persistence: NodeTestingPersistence;
  expressionEvaluator: ExpressionEvaluator;
}>;
