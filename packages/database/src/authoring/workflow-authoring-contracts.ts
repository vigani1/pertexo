import type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewRunRecord,
} from '../execution/preview-execution.js';
import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './workflow-authoring-records.js';

export type CreateWorkflowInput = Readonly<{
  id?: string;
  workspaceId: string;
  actorId: string;
  name: string;
  emptyGraph: unknown;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type CreateWorkflowResult = Readonly<{
  workflowId: string;
  workflow: WorkflowRecord;
  draft: WorkflowDraftRecord;
}>;
export type SaveWorkflowDraftInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  expectedRevision: number;
  graphJson: unknown;
  requestId?: string;
  traceId?: string;
}>;
export type RestoreWorkflowVersionInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  versionId: string;
  actorId: string;
  representationTag: string;
  requestId?: string;
  traceId?: string;
}>;
export type PublishWorkflowInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  representationTag: string;
  /** Canonical application request digest, including the original If-Match. */ requestHash: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;
export type ListWorkflowsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit?: number;
  after?: Readonly<{ createdAt: Date; id: string }>;
}>;
export type WorkflowPage = Readonly<{
  items: readonly WorkflowRecord[];
  nextCursor?: Readonly<{ createdAt: Date; id: string }>;
}>;
export type ListWorkflowVersionsInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  limit?: number;
  beforeVersionNumber?: number;
}>;
export type WorkflowVersionPage = Readonly<{
  items: readonly WorkflowVersionRecord[];
  nextCursor?: Readonly<{ beforeVersionNumber: number }>;
}>;
export type PublishWorkflowResult = Readonly<{
  version: WorkflowVersionRecord;
  reused: boolean;
  replayed: boolean;
}>;
export type WorkflowLifecycleCommand = 'archive' | 'restore';
export type TransitionWorkflowLifecycleInput = Readonly<{
  command: WorkflowLifecycleCommand;
  workspaceId: string;
  workflowId: string;
  actorId: string;
  expectedLifecycleRevision: number;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;
export type TransitionWorkflowLifecycleResult = Readonly<{
  workflow: WorkflowRecord;
  replayed: boolean;
}>;

export type WorkflowAuthoringDatabase = Readonly<{
  acceptPreview(
    input: AcceptPreviewRunInput & Readonly<{ workspaceId: string }>,
  ): Promise<AcceptedPreviewRun>;
  readPreview(
    input: Readonly<{
      workspaceId: string;
      actorUserId: string;
      previewRunId: string;
    }>,
  ): Promise<PreviewRunRecord | null>;
  createWorkflow(input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
  listWorkflows(input: ListWorkflowsInput): Promise<WorkflowPage>;
  getDraft(
    workspaceId: string,
    workflowId: string,
    actorId: string,
  ): Promise<WorkflowDraftRecord | null>;
  getVersion(
    workspaceId: string,
    workflowId: string,
    versionId: string,
    actorId: string,
  ): Promise<WorkflowVersionRecord | null>;
  listVersions(input: ListWorkflowVersionsInput): Promise<WorkflowVersionPage>;
  saveDraft(input: SaveWorkflowDraftInput): Promise<WorkflowDraftRecord>;
  restoreWorkflowVersion(
    input: RestoreWorkflowVersionInput,
  ): Promise<WorkflowDraftRecord>;
  publishWorkflow(input: PublishWorkflowInput): Promise<PublishWorkflowResult>;
  transitionWorkflowLifecycle(
    input: TransitionWorkflowLifecycleInput,
  ): Promise<TransitionWorkflowLifecycleResult>;
  close(): Promise<void>;
}>;
