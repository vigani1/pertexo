import type { RunValues } from '@pertexo/node-sdk';
import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { WorkspaceVariableSnapshot } from '@pertexo/workflow-model';
import type {
  UsageCapacityResponse,
  UsageTrendPeriod,
  UsageTrendsResponse,
  WorkflowCallSummary,
  WorkflowRunErrorWorkflow,
  WorkflowRecoveryPreview,
  WorkflowRecoverySummary,
  WorkflowNodeReuse,
  WorkflowParentCall,
  WorkflowRunAdmissionBlockers,
} from '@pertexo/contracts';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../authorization/index.js';

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
  triggerType:
    | 'api'
    | 'manual'
    | 'replay'
    | 'schedule'
    | 'webhook'
    | 'workflow_call'
    | 'workflow_error'
    | 'test'
    | 'form';
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  deadlineAt: Date | null;
  cancelRequestedAt: Date | null;
}>;

export type WorkflowRunReadRecord = WorkflowRunRecord &
  Readonly<{
    hasHumanTasks?: boolean;
    runValues?: RunValues;
    humanWait?: Readonly<{
      since: string;
      remainingExecutionMs: number | null;
      absoluteDeadlineAt: string | null;
    }>;
    workflowName?: string | null;
    replaySourceRunId?: string | null;
    admissionBlockers?: WorkflowRunAdmissionBlockers;
    recovery?: WorkflowRecoverySummary;
    handledFailureCount?: number;
  }>;

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
  failureHandling?: Readonly<{
    entryInvocationKey: string;
    sinkInvocationKey: string;
    disposition: 'pending' | 'handled';
  }>;
  reused?: WorkflowNodeReuse;
  startedAt: Date | null;
  completedAt: Date | null;
  resumeAt: Date | null;
  errorSummary?: string;
  safeErrorCode: string | null;
}>;

export type WorkflowRunReadModel = Readonly<{
  run: WorkflowRunReadRecord;
  nodes: readonly WorkflowNodeRunRecord[];
  calls?: readonly WorkflowCallSummary[];
  parentCall?: WorkflowParentCall;
  errorWorkflow?: WorkflowRunErrorWorkflow;
}>;

export type WorkflowRunListPosition = Readonly<{
  createdAt: string;
  id: string;
}>;

export type ListWorkflowRunsQuery = Readonly<{
  actorId: string;
  workspaceId: string;
  limit: number;
  workflowId?: string;
  runValueKey?: string;
  runValue?: string;
  workflowNamePrefix?: string;
  includeWorkflowName: boolean;
  status?: WorkflowRunRecord['status'];
  createdAtFrom?: string;
  createdAtBefore?: string;
  after?: WorkflowRunListPosition;
}>;

export type WorkflowRunStatisticsWindow = '1h' | '6h' | '24h' | '7d';

export type WorkflowRunStatisticsQuery = Readonly<{
  actorId: string;
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
    skippedTriggerEvents?: number;
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
  expectedPublishedVersionId?: string;
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

export type RecoverWorkflowRunCommand = Omit<
  ReplayWorkflowRunCommand,
  'input'
> &
  Readonly<{
    nodeRunId: string;
    acknowledgePossibleEffects?: true;
    acknowledgeUnknownOutcome?: true;
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
  canRead(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      runId: string;
      signal?: AbortSignal | undefined;
    }>,
  ): Promise<boolean>;
  recovery(
    input: Readonly<{ actorId: string; workspaceId: string; runId: string }>,
  ): Promise<WorkflowRecoveryPreview>;
  recover(
    input: RecoverWorkflowRunCommand,
  ): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>>;

  usageTrends(
    input: Readonly<{
      actorId: string;
      workspaceId: string;
      period: UsageTrendPeriod;
      includeWorkflowNames: boolean;
      signal?: AbortSignal;
    }>,
  ): Promise<UsageTrendsResponse>;
  usageCapacity(
    input: Readonly<{ workspaceId: string; signal?: AbortSignal }>,
  ): Promise<UsageCapacityResponse>;
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
      actorId: string;
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
  readVariables(
    input: Readonly<{ actorId: string; workspaceId: string; runId: string }>,
  ): Promise<WorkspaceVariableSnapshot | null | undefined>;
  readInput(
    input: Readonly<{ actorId: string; workspaceId: string; runId: string }>,
  ): Promise<WorkflowRunDataRecord | undefined>;
  readNodeRunDiagnostics(
    input: Readonly<{
      actorId: string;
      workspaceId: string;
      runId: string;
      nodeRunId: string;
    }>,
  ): Promise<CodeDiagnostics | null | undefined>;
  readNodeRunOutput(
    input: Readonly<{
      actorId: string;
      workspaceId: string;
      runId: string;
      nodeRunId: string;
    }>,
  ): Promise<WorkflowRunDataRecord | undefined>;
  readNodeRunInput(
    input: Readonly<{
      actorId: string;
      workspaceId: string;
      runId: string;
      nodeRunId: string;
    }>,
  ): Promise<WorkflowRunDataRecord | undefined>;
  stepHealth(
    input: Readonly<{
      actorId: string;
      workspaceId: string;
      workflowId: string;
    }>,
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
      actorId: string;
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
