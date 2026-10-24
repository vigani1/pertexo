import type { connectionScope } from '../../../../tenant-access/resources/connections/scope.js';
import type { readFolderScope } from '../../../../tenant-access/resources/facts.queries.js';

import type {
  WorkflowPromotionPreview,
  WorkflowPromotionRequirement,
} from '@pertexo/contracts';

import type { DataTableDefinition } from '../../../../data-tables/contract.js';

import type { PromotionScope } from '../../contract.js';
import type { PromotionGraphBudget } from '../graph.js';
import type { PromotionSourceSet } from '../source.queries.js';

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
