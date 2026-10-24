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

export interface Origin {
  workflow_id: string;
  graph_digest: string;
  target_name: string;
  draft_revision: number;
  published_version_id: string | null;
  promotion_id: string;
}

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

export interface TargetWorkflowRow {
  name: string;
  revision: number;
  graph_json: unknown;
  published_version_id: string | null;
  lifecycle_status: string;
}
