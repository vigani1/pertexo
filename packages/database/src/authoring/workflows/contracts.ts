import type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewRunRecord,
  PreviewReplayRecord,
  ResolvePreviewReplayInput,
} from '../../previews/repository.js';
import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './representation/records.js';
import type {
  GraphValidationResult,
  PortableConnectionBinding,
  PortableIssue,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type { WorkflowAutoPauseDatabase } from '../settings/auto-pause.js';
import type { WorkflowConcurrencyDatabase } from '../settings/concurrency.js';
import type {
  WorkflowTemplateOriginRequest,
  WorkflowTemplateOrigin,
} from '@pertexo/templates';

export type ExportWorkflowInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  source:
    | Readonly<{ kind: 'draft' }>
    | Readonly<{ kind: 'version'; versionId: string }>;
  reviewedGraphDigest: string;
  representationTag?: string;
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}>;
export type PreviewWorkflowImportInput = Readonly<{
  workspaceId: string;
  actorId: string;
  manifest: WorkflowPortableManifest;
  bindings: readonly PortableConnectionBinding[];
  templateOrigin?: WorkflowTemplateOriginRequest;
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}>;
export type PreviewWorkflowImportResult = Readonly<{
  manifestDigest: string;
  compatibilityFingerprint: string;
  compatible: boolean;
  issues: readonly PortableIssue[];
  truncated: boolean;
  connectionSlots: WorkflowPortableManifest['connectionSlots'];
}>;
export type ImportWorkflowInput = PreviewWorkflowImportInput &
  Readonly<{
    name: string;
    expectedCompatibilityFingerprint: string;
    idempotencyKey: string;
  }>;
export type ImportWorkflowResult = Readonly<{ workflowId: string }>;

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
export type DuplicateWorkflowInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  name: string;
  source:
    | Readonly<{ kind: 'draft' }>
    | Readonly<{ kind: 'version'; versionId: string }>;
  representationTag?: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}>;
export type DuplicateWorkflowResult = Readonly<{ workflowId: string }>;
export type SaveWorkflowDraftInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  /** Original opaque If-Match value, rechecked under write-time compatibility authority. */
  representationTag: string;
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
  signal?: AbortSignal;
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
  order?: 'created_asc' | 'updated_desc';
  after?: Readonly<{ positionAt: string; id: string }>;
}>;
export type WorkflowPage = Readonly<{
  items: readonly WorkflowRecord[];
  nextCursor?: Readonly<{ positionAt: string; id: string }>;
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
export type RenameWorkflowInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  name: string;
  expectedNameRevision: number;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type RenameWorkflowResult = Readonly<{
  workflow: WorkflowRecord;
  replayed: boolean;
}>;

export type WorkflowAuthoringDatabase = Readonly<{
  exportWorkflow(input: ExportWorkflowInput): Promise<WorkflowPortableManifest>;
  previewWorkflowImport(
    input: PreviewWorkflowImportInput,
  ): Promise<PreviewWorkflowImportResult>;
  importWorkflow(input: ImportWorkflowInput): Promise<ImportWorkflowResult>;
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
  resolvePreviewReplay(
    input: ResolvePreviewReplayInput & Readonly<{ workspaceId: string }>,
  ): Promise<PreviewReplayRecord | null>;
  createWorkflow(input: CreateWorkflowInput): Promise<CreateWorkflowResult>;
  duplicateWorkflow(
    input: DuplicateWorkflowInput,
  ): Promise<DuplicateWorkflowResult>;
  listWorkflows(input: ListWorkflowsInput): Promise<WorkflowPage>;
  getWorkflow(
    workspaceId: string,
    workflowId: string,
    actorId: string,
  ): Promise<WorkflowRecord | null>;
  getWorkflowWithTemplateOrigin(
    workspaceId: string,
    workflowId: string,
    actorId: string,
  ): Promise<Readonly<{
    workflow: WorkflowRecord;
    templateOrigin: WorkflowTemplateOrigin | null;
  }> | null>;
  getDraft(
    workspaceId: string,
    workflowId: string,
    actorId: string,
  ): Promise<WorkflowDraftRecord | null>;
  validateDraft(
    workspaceId: string,
    workflowId: string,
    actorId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{
    draft: WorkflowDraftRecord;
    validation: GraphValidationResult;
  }> | null>;
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
  renameWorkflow(input: RenameWorkflowInput): Promise<RenameWorkflowResult>;
  close(): Promise<void>;
  readonly autoPause?: WorkflowAutoPauseDatabase;
  readonly concurrency?: WorkflowConcurrencyDatabase;
}>;
