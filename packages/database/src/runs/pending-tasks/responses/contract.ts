import type {
  ApprovalAudiencePage,
  ApprovalAudienceInspectionRequest,
  ApprovalAudienceInspectionResponse,
  ApprovalAudienceQuery,
  PendingTaskDecisionRequest,
  PendingTaskSubmitRequest,
  PendingTaskDecisionResponse,
  PendingTaskDetail,
  PendingTaskListQuery,
  PendingTaskListResponse,
} from '@pertexo/contracts';

export type PendingTaskScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
  requestId?: string;
  traceId?: string;
}>;
export interface PendingTaskStore {
  list(
    input: PendingTaskScope & PendingTaskListQuery,
  ): Promise<PendingTaskListResponse>;
  read(
    input: PendingTaskScope & Readonly<{ taskId: string }>,
  ): Promise<PendingTaskDetail>;
  decide(
    input: PendingTaskScope &
      PendingTaskDecisionRequest &
      Readonly<{ taskId: string; idempotencyKey: string }>,
  ): Promise<PendingTaskDecisionResponse>;
  submit(
    input: PendingTaskScope &
      PendingTaskSubmitRequest &
      Readonly<{ taskId: string; idempotencyKey: string }>,
  ): Promise<PendingTaskDecisionResponse>;
  audience(
    input: PendingTaskScope & ApprovalAudienceQuery,
  ): Promise<ApprovalAudiencePage>;
  inspectAudience(
    input: PendingTaskScope & ApprovalAudienceInspectionRequest,
  ): Promise<ApprovalAudienceInspectionResponse>;
  close(): Promise<void>;
}
