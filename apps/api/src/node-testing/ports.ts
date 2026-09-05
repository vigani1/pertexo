import type { WorkflowAuthoringDatabase } from '@pertexo/database/api';
import type { RegistryRelease } from '@pertexo/node-sdk';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';

import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { WorkspaceAuthorizationPort } from '../workspaces/index.js';

export type NodeTestingPersistence = Pick<
  WorkflowAuthoringDatabase,
  'acceptPreview' | 'getDraft' | 'readPreview'
>;

export type NodeTestingDependencies = Readonly<{
  authorization: WorkspaceAuthorizationSource | WorkspaceAuthorizationPort;
  persistence: NodeTestingPersistence;
  release: RegistryRelease;
  expressionEvaluator: ExpressionEvaluator;
}>;
