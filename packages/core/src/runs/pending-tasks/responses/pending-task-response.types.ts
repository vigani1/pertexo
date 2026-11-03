import type {
  PendingTaskDecisionRequest,
  PendingTaskSubmitRequest,
} from '@pertexo/contracts';

export type PendingTaskScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
  requestId?: string;
  traceId?: string;
}>;
export type PendingTaskRead = PendingTaskScope & Readonly<{ taskId: string }>;
export type PendingTaskDecision = PendingTaskScope &
  PendingTaskDecisionRequest &
  Readonly<{ taskId: string; idempotencyKey: string }>;
export type PendingTaskSubmission = PendingTaskScope &
  PendingTaskSubmitRequest &
  Readonly<{ taskId: string; idempotencyKey: string; uploadSession?: string }>;
