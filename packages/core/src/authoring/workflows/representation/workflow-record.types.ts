import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { workflowCompatibilityReport } from '@pertexo/workflow-model/server';
import type {
  workflowDrafts,
  workflows,
  workflowVersions,
} from '@pertexo/database/schema';

// Trigger readiness and resource access are computed from joined authoring state.
export type WorkflowRecord = Readonly<
  Pick<
    typeof workflows.$inferSelect,
    | 'id'
    | 'workspaceId'
    | 'name'
    | 'nameRevision'
    | 'lifecycleStatus'
    | 'lifecycleRevision'
    | 'activationStatus'
    | 'publishedVersionId'
    | 'createdBy'
    | 'createdAt'
    | 'updatedAt'
  > & {
    webhookSetupRequired: boolean;
    resourceAccess?: Readonly<{ canEdit: boolean; canPublish: boolean }>;
  }
>;

// Stored graphs are decoded and compatibility is computed on read.
export type WorkflowDraftRecord = Readonly<
  Omit<typeof workflowDrafts.$inferSelect, 'graphJson'> & {
    graphJson: WorkflowGraph;
    compatibility: ReturnType<typeof workflowCompatibilityReport>;
  }
>;

export type WorkflowVersionRecord = Readonly<
  Omit<typeof workflowVersions.$inferSelect, 'graphJson' | 'executableJson'> & {
    graphJson: WorkflowGraph;
  }
>;
