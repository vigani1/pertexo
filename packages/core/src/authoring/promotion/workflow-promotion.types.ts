import type {
  WorkflowPromotionApply,
  WorkflowPromotionCandidatesQuery,
  WorkflowPromotionPageQuery,
  WorkflowPromotionPreviewRequest,
  WorkflowPromotionTarget,
} from '@pertexo/contracts';
import type { WorkspaceScopeRunner } from '@pertexo/database/primitives';
import type { AuthoringAccess } from '../workflows/access.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

export type PromotionScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;

export type PromotionCommand = PromotionScope &
  Readonly<{
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type SetPromotionTargetInput = PromotionCommand &
  WorkflowPromotionTarget;
export type PromotionCandidatesInput = PromotionScope &
  WorkflowPromotionCandidatesQuery;
export type PreviewPromotionInput = PromotionScope &
  WorkflowPromotionPreviewRequest;
export type ApplyPromotionInput = PromotionCommand & WorkflowPromotionApply;
export type PromotionHistoryInput = PromotionScope & WorkflowPromotionPageQuery;

export type PromotionContext = Readonly<{
  access: AuthoringAccess;
  catalogs: AuthoringCatalogs;
  transactScopes<T>(
    operation: (inWorkspace: WorkspaceScopeRunner) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;
