import type { WorkflowRunDatabase } from '@pertexo/core/runs';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../authorization/index.js';

type StoredReadModel = NonNullable<
  Awaited<ReturnType<WorkflowRunDatabase['get']>>
>;
export type WorkflowRunRecord = Awaited<
  ReturnType<WorkflowRunDatabase['start']>
>['run'];
/** Fakes can omit lineage that their scenario does not exercise. */
export type WorkflowRunReadRecord = Omit<
  StoredReadModel['run'],
  'replaySourceRunId'
> &
  Partial<Pick<StoredReadModel['run'], 'replaySourceRunId'>>;
export type WorkflowRunListRecord = WorkflowRunReadRecord &
  Partial<
    Pick<
      Awaited<ReturnType<WorkflowRunDatabase['list']>>['items'][number],
      'failedStep'
    >
  >;
export type WorkflowRunReadModel = Omit<StoredReadModel, 'run'> &
  Readonly<{ run: WorkflowRunReadRecord }>;
export type WorkflowRunListPosition = NonNullable<
  Parameters<WorkflowRunDatabase['list']>[0]['after']
>;
export type ListWorkflowRunsQuery = Parameters<WorkflowRunDatabase['list']>[0] &
  Readonly<{ includeWorkflowName: boolean }>;
export type WorkflowRunStatisticsQuery = Required<
  Pick<
    Parameters<WorkflowRunDatabase['statistics']>[0],
    | 'actorId'
    | 'workspaceId'
    | 'window'
    | 'includeWorkflows'
    | 'includeWorkflowName'
  >
>;
export type WorkflowRunStatisticsWindow = WorkflowRunStatisticsQuery['window'];
export type WorkflowRunStatisticsRecord = Awaited<
  ReturnType<WorkflowRunDatabase['statistics']>
>;
export type StartWorkflowRunCommand = Omit<
  Parameters<WorkflowRunDatabase['start']>[0],
  'checkpointFactory'
>;
export type ReplayWorkflowRunCommand = Omit<
  Parameters<WorkflowRunDatabase['replay']>[0],
  'checkpointFactory'
> &
  Readonly<{ input: unknown }>;
export type RecoverWorkflowRunCommand = Omit<
  Parameters<WorkflowRunDatabase['recover']>[0],
  'prepareRecovery'
>;
export type CancelWorkflowRunCommand = Parameters<
  WorkflowRunDatabase['cancel']
>[0];

export type WorkflowRunPersistence = Pick<
  WorkflowRunDatabase,
  | 'canRead'
  | 'usageTrends'
  | 'usageCapacity'
  | 'statistics'
  | 'readVariables'
  | 'readInput'
  | 'readNodeRunDiagnostics'
  | 'readNodeRunOutput'
  | 'readNodeRunInput'
  | 'stepHealth'
  | 'stepRuns'
> &
  Readonly<{
    recovery(
      input: Omit<
        Parameters<WorkflowRunDatabase['recovery']>[0],
        'prepareRecovery'
      >,
    ): ReturnType<WorkflowRunDatabase['recovery']>;
    recover(
      input: RecoverWorkflowRunCommand,
    ): ReturnType<WorkflowRunDatabase['recover']>;
    start(
      input: StartWorkflowRunCommand,
    ): ReturnType<WorkflowRunDatabase['start']>;
    replay(
      input: ReplayWorkflowRunCommand,
    ): ReturnType<WorkflowRunDatabase['replay']>;
    get(
      input: Parameters<WorkflowRunDatabase['get']>[0],
    ): Promise<WorkflowRunReadModel | undefined>;
    list(input: ListWorkflowRunsQuery): Promise<
      Readonly<{
        items: readonly WorkflowRunListRecord[];
        nextCursor?: WorkflowRunListPosition;
      }>
    >;
    cancel(
      input: CancelWorkflowRunCommand,
    ): Promise<
      Pick<
        Awaited<ReturnType<WorkflowRunDatabase['cancel']>>,
        'run' | 'alreadyRequested'
      >
    >;
  }>;

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
