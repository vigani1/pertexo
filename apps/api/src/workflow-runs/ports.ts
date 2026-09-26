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

export type WorkflowRunReadRecord = WorkflowRunRecord &
  Readonly<{ workflowName?: string | null; replaySourceRunId?: string | null }>;

/** The step that explains an unsuccessful listed run (ADR 050). */
type WorkflowRunFailedStepRecord = Readonly<{
  nodeId: string;
  label: string | null;
  definitionKey: string | null;
  safeErrorCode: string | null;
}>;

export type WorkflowRunListRecord = WorkflowRunReadRecord &
  Readonly<{ failedStep?: WorkflowRunFailedStepRecord | null }>;

/** One step across the workflow's last 100 runs (ADR 051). */
export type WorkflowStepHealthRecord = Readonly<{
  nodeId: string;
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  lastStatus: WorkflowNodeRunRecord['status'];
  lastRanAt: Date;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
}>;

/** One run of one step, with the run it belongs to (ADR 051). */
export type WorkflowStepRunRecord = Readonly<{
  runId: string;
  runStatus: WorkflowRunRecord['status'];
  runCreatedAt: Date;
  workflowVersionId: string;
  nodeRunId: string;
  invocationKey: string;
  status: WorkflowNodeRunRecord['status'];
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  safeErrorCode: string | null;
}>;

/** A run's input or a node run's output as stored (ADR 050). */
export type WorkflowRunDataRecord =
  | Readonly<{ kind: 'inline'; value: unknown }>
  | Readonly<{ kind: 'artifact'; artifactId: string }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'expired' }>;

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
  run: WorkflowRunReadRecord;
  nodes: readonly WorkflowNodeRunRecord[];
}>;

export type WorkflowRunListPosition = Readonly<{
  createdAt: string;
  id: string;
}>;

export type ListWorkflowRunsQuery = Readonly<{
  workspaceId: string;
  limit: number;
  workflowId?: string;
  workflowNamePrefix?: string;
  includeWorkflowName: boolean;
  status?: WorkflowRunRecord['status'];
  createdAtFrom?: string;
  createdAtBefore?: string;
  after?: WorkflowRunListPosition;
}>;

export type WorkflowRunStatisticsWindow = '1h' | '6h' | '24h' | '7d';

export type WorkflowRunStatisticsQuery = Readonly<{
  workspaceId: string;
  window: WorkflowRunStatisticsWindow;
  includeWorkflows: boolean;
  includeWorkflowName: boolean;
}>;

type WorkflowRunStatusCounts = Readonly<
  Record<WorkflowRunRecord['status'], number>
>;

/** Exact counts for one workspace snapshot at `asOf` (ADR 044). */
export type WorkflowRunStatisticsRecord = Readonly<{
  asOf: string;
  current: Readonly<Record<'queued' | 'running' | 'waiting', number>>;
  window: Readonly<{
    duration: WorkflowRunStatisticsWindow;
    createdAtFrom: string;
    createdAtBefore: string;
    total: number;
    byStatus: WorkflowRunStatusCounts;
  }>;
  workflows?: Readonly<{
    items: readonly Readonly<{
      workflowId: string;
      workflowName: string | null;
      total: number;
      byStatus: WorkflowRunStatusCounts;
    }>[];
    truncated: boolean;
  }>;
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

export type ReplayWorkflowRunCommand = Readonly<{
  actorId: string;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  scope: string;
  input: unknown;
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
  replay(input: ReplayWorkflowRunCommand): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      replayed: boolean;
    }>
  >;
  get(
    input: Readonly<{
      workspaceId: string;
      runId: string;
      includeWorkflowName?: boolean;
    }>,
  ): Promise<WorkflowRunReadModel | undefined>;
  list(input: ListWorkflowRunsQuery): Promise<
    Readonly<{
      items: readonly WorkflowRunListRecord[];
      nextCursor?: WorkflowRunListPosition;
    }>
  >;
  statistics(
    input: WorkflowRunStatisticsQuery,
  ): Promise<WorkflowRunStatisticsRecord>;
  readInput(
    input: Readonly<{ workspaceId: string; runId: string }>,
  ): Promise<WorkflowRunDataRecord | undefined>;
  readNodeRunOutput(
    input: Readonly<{ workspaceId: string; runId: string; nodeRunId: string }>,
  ): Promise<WorkflowRunDataRecord | undefined>;
  stepHealth(
    input: Readonly<{ workspaceId: string; workflowId: string }>,
  ): Promise<
    | Readonly<{
        runsConsidered: number;
        oldestRunAt: Date | null;
        items: readonly WorkflowStepHealthRecord[];
      }>
    | undefined
  >;
  stepRuns(
    input: Readonly<{
      workspaceId: string;
      workflowId: string;
      nodeId: string;
      limit: number;
    }>,
  ): Promise<readonly WorkflowStepRunRecord[] | undefined>;
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
      onProducerFailure?(error: unknown): void;
    }>,
  ): AsyncIterable<WorkflowRunEventFrame>;
}
