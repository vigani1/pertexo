import type {
  WorkflowPromotionApply,
  WorkflowPromotionCandidates,
  WorkflowPromotionCandidatesQuery,
  WorkflowPromotionHistory,
  WorkflowPromotionPageQuery,
  WorkflowPromotionPreview,
  WorkflowPromotionPreviewRequest,
  WorkflowPromotionResult,
  WorkflowPromotionSettings,
  WorkflowPromotionTarget,
  WorkflowPromotionTargetResult,
} from '@pertexo/contracts';
import type { WorkspaceScopeRunner } from '@pertexo/database/primitives';
import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';

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

export interface WorkflowPromotionStore {
  settings(input: PromotionScope): Promise<WorkflowPromotionSettings>;
  setTarget(
    input: PromotionCommand & WorkflowPromotionTarget,
  ): Promise<WorkflowPromotionTargetResult>;
  candidates(
    input: PromotionScope & WorkflowPromotionCandidatesQuery,
  ): Promise<WorkflowPromotionCandidates>;
  preview(
    input: PromotionScope & WorkflowPromotionPreviewRequest,
  ): Promise<WorkflowPromotionPreview>;
  apply(
    input: PromotionCommand & WorkflowPromotionApply,
  ): Promise<WorkflowPromotionResult>;
  history(
    input: PromotionScope & WorkflowPromotionPageQuery,
  ): Promise<WorkflowPromotionHistory>;
}

export type PromotionContext = WorkflowAuthoringWriteContext &
  Readonly<{
    transactScopes<T>(
      operation: (inWorkspace: WorkspaceScopeRunner) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T>;
  }>;
