import type { PoolClient } from 'pg';

export type WorkflowAutoPauseSettings = Readonly<{
  enabled: boolean;
  thresholdOverride: number | null;
  workspaceThreshold: number;
  effectiveThreshold: number;
  settingsRevision: number;
  pauseState: 'none' | 'paused';
  pauseRevision: string;
  pausedAt: string | null;
  pauseReason: 'consecutive_failures' | null;
  pausedFailures: number | null;
  pausedLastRunId: string | null;
}>;

export type WorkspaceAutoPauseSettings = Readonly<{
  threshold: number;
  revision: number;
}>;

export type WorkspaceAutoPauseScope = Readonly<{
  workspaceId: string;
  actorId: string;
}>;

export type WorkflowAutoPauseScope = WorkspaceAutoPauseScope &
  Readonly<{ workflowId: string }>;

type Command = Readonly<{
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;

export type AutoPauseCommandResult<T> = Readonly<{
  settings: T;
  replayed: boolean;
}>;

export type UpdateWorkflowAutoPauseInput = WorkflowAutoPauseScope &
  Command &
  Readonly<{
    enabled: boolean;
    thresholdOverride: number | null;
    expectedSettingsRevision: number;
  }>;
export type ResumeWorkflowInput = WorkflowAutoPauseScope &
  Command &
  Readonly<{ expectedPauseRevision: string }>;
export type UpdateWorkspaceAutoPauseInput = WorkspaceAutoPauseScope &
  Command &
  Readonly<{ threshold: number; expectedRevision: number }>;

export type Transact = <T>(
  workspaceId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
) => Promise<T>;

export type CommandInput = Readonly<{
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
