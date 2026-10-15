import type {
  ApprovalAudiencePage,
  ApprovalAudienceQuery,
  PendingTaskDecisionRequest,
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
  audience(
    input: PendingTaskScope & ApprovalAudienceQuery,
  ): Promise<ApprovalAudiencePage>;
  close(): Promise<void>;
}
export class PendingTaskNotFoundError extends Error {
  override readonly name = 'PendingTaskNotFoundError';
}
export class PendingTaskDecisionError extends Error {
  override readonly name = 'PendingTaskDecisionError';
  constructor(
    readonly reason:
      'resolved' | 'expired' | 'run_closed' | 'starter' | 'audience',
  ) {
    super('This task cannot be decided.');
  }
}
