import type { WorkflowAuthoringDatabase } from '@pertexo/database/authoring';
import type { RegistryRelease } from '@pertexo/node-sdk';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';

export type NodeTestingPersistence = Pick<
  WorkflowAuthoringDatabase,
  'acceptPreview' | 'getDraft' | 'readPreview' | 'resolvePreviewReplay'
>;

export type NodeTestingDependencies = Readonly<{
  authorization: WorkspaceAuthorizationSource;
  persistence: NodeTestingPersistence;
  release: RegistryRelease;
  expressionEvaluator: ExpressionEvaluator;
}>;
