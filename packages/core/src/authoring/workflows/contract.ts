import type { WorkflowTemplateOriginRequest } from '@pertexo/workflow-model';
import type {
  PortableConnectionBinding,
  PortableIssue,
  WorkflowGraph,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './representation/contract.js';

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
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}> &
  TemplateVerification;
type TemplateVerification =
  | Readonly<{ templateOrigin?: undefined; templateIssues?: never }>
  | Readonly<{
      templateOrigin: WorkflowTemplateOriginRequest;
      templateIssues: readonly PortableIssue[];
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
    commandCredentialId?: string;
  }>;
export type ImportWorkflowResult = Readonly<{ workflowId: string }>;

export type CreateWorkflowInput = Readonly<{
  id?: string;
  folderId?: string | null;
  workspaceId: string;
  actorId: string;
  name: string;
  emptyGraph: WorkflowGraph;
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
  graphJson: WorkflowGraph;
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
  commandCredentialId?: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;
export type ListWorkflowsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit?: number;
  order?: 'created_asc' | 'updated_desc';
  pinsWorkflowId?: string;
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
  versionId?: string;
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
