import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../workspaces/index.js';

export type WorkflowRunRecord = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown';
  triggerType: 'api' | 'manual' | 'replay' | 'schedule' | 'webhook';
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  deadlineAt: Date | null;
  cancelRequestedAt: Date | null;
}>;

export type WorkflowNodeRunRecord = Readonly<{
  id: string;
  nodeId: string;
  invocationKey: string;
  status:
    | 'pending'
    | 'ready'
    | 'running'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown';
  currentAttemptNumber: number;
  startedAt: Date | null;
  completedAt: Date | null;
  resumeAt: Date | null;
  safeErrorCode: string | null;
}>;

export type WorkflowRunReadModel = Readonly<{
  run: WorkflowRunRecord;
  nodes: readonly WorkflowNodeRunRecord[];
}>;

export type StartWorkflowRunCommand = Readonly<{
  actorId: string;
  workspaceId: string;
  workflowId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  scope: string;
  input?: unknown;
  deadlineAt?: Date;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;

export type CancelWorkflowRunCommand = Readonly<{
  actorId: string;
  workspaceId: string;
  runId: string;
  reason?: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;

export interface WorkflowRunPersistence {
  start(input: StartWorkflowRunCommand): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      replayed: boolean;
    }>
  >;
  get(
    input: Readonly<{ workspaceId: string; runId: string }>,
  ): Promise<WorkflowRunReadModel | undefined>;
  cancel(input: CancelWorkflowRunCommand): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      alreadyRequested: boolean;
    }>
  >;
}

export type WorkflowRunApplicationInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}>;

export type WorkflowRunEventFrame = Readonly<{
  id: number;
  event: string;
  data: string;
  visibilityPath?:
    | 'initial_backfill'
    | 'reconnect_backfill'
    | 'live_wakeup'
    | 'recovery_backfill';
}>;

export interface WorkflowRunEventStreamer {
  stream(
    input: Readonly<{
      workspaceId: string;
      runId: string;
      lastEventId: number;
      signal: AbortSignal;
    }>,
  ): AsyncIterable<WorkflowRunEventFrame>;
}
