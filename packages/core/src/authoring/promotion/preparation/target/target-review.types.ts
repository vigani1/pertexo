import type { connectionScope } from '../../../../shared/resources/connection-scope.repository.js';
import type { readFolderScope } from '../../../../shared/folder-access-facts.repository.js';

import type {
  WorkflowPromotionPreview,
  WorkflowPromotionRequirement,
} from '@pertexo/contracts';

import type { DataTableDefinition } from '@pertexo/contracts';

import type { PromotionScope } from '../../workflow-promotion.types.js';
import type { PromotionGraphBudget } from '../graph.js';
import type { PromotionSourceSet } from '../source.repository.js';

export type ReviewedWorkflow = WorkflowPromotionPreview['workflows'][number];

export type TargetReviewState = Readonly<{
  input: PromotionScope;
  sourceWorkspaceId: string;
  sources: PromotionSourceSet;
  budget: PromotionGraphBudget;
  scope: Awaited<ReturnType<typeof readFolderScope>>;
  connections: ReturnType<typeof connectionScope>;
  tables: DataTableDefinition[];
  requirements: WorkflowPromotionRequirement[];
  report: (requirement: WorkflowPromotionRequirement) => void;
}>;
