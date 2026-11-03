import type {
  WorkflowRunApplicationInput,
  WorkflowRunRecord,
} from '../ports.js';

export type StartWorkflowRunInput = WorkflowRunApplicationInput &
  Readonly<{
    workflowId: string;
    idempotencyKey: string;
    input?: unknown;
    expectedPublishedVersionId?: string;
    deadlineAt?: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type ReplayWorkflowRunInput = WorkflowRunApplicationInput &
  Readonly<{
    runId: string;
    workflowVersionId: string;
    idempotencyKey: string;
    input: unknown;
    deadlineAt?: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type GetWorkflowRunInput = WorkflowRunApplicationInput &
  Readonly<{ runId: string }>;

export type ListWorkflowRunsInput = WorkflowRunApplicationInput &
  Readonly<{
    limit?: number;
    after?: string;
    workflowId?: string;
    status?: WorkflowRunRecord['status'];
    createdAtFrom?: string;
    createdAtBefore?: string;
    workflowNamePrefix?: string;
    runValueKey?: string;
    runValue?: string;
  }>;

export type CancelWorkflowRunInput = GetWorkflowRunInput &
  Readonly<{
    reason?: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type StreamRunEventsInput = GetWorkflowRunInput &
  Readonly<{
    lastEventId: number;
    sessionExpiresAt: Date;
    reauthorizeSession: (signal: AbortSignal) => Promise<
      Readonly<{
        userId: string;
        sessionId: string;
        expiresAt: Date;
      }>
    >;
    abortStream(reason?: unknown): void;
    signal: AbortSignal;
  }>;
