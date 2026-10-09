import type {
  WorkflowActivationStatus,
  WorkflowGraph,
  WorkflowLifecycleStatus,
} from '@pertexo/workflow-model';
import type { workflowCompatibilityReport } from '@pertexo/workflow-model/server';

export type WorkflowRecord = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  nameRevision: number;
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
