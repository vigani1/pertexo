import type {
  workflowCompatibilityReport,
  WorkflowGraph,
} from '@pertexo/workflow-model/graph';
import type {
  WorkflowActivationStatus,
  WorkflowLifecycleStatus,
} from '@pertexo/workflow-model/lifecycle';

export type WorkflowRecord = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  lifecycleStatus: WorkflowLifecycleStatus;
  lifecycleRevision: number;
  activationStatus: WorkflowActivationStatus;
  publishedVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkflowDraftRecord = Readonly<{
  workflowId: string;
  workspaceId: string;
  revision: number;
  schemaVersion: number;
  graphJson: WorkflowGraph;
  compatibility: ReturnType<typeof workflowCompatibilityReport>;
  updatedBy: string;
  updatedAt: Date;
}>;

export type WorkflowVersionRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  schemaVersion: number;
  graphJson: WorkflowGraph;
  checksum: string;
  publishedBy: string;
  publishedAt: Date;
}>;
