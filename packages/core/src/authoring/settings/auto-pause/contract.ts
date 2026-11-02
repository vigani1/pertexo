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

type Scope = Readonly<{ workspaceId: string; actorId: string }>;

type WorkflowScope = Scope & Readonly<{ workflowId: string }>;

type Command = Readonly<{
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;

export type AutoPauseCommandResult<T> = Readonly<{
  settings: T;
  replayed: boolean;
}>;

export interface WorkflowAutoPauseStore {
  readWorkflowSettings(
    input: WorkflowScope,
  ): Promise<WorkflowAutoPauseSettings>;
  updateWorkflowSettings(
    input: WorkflowScope &
      Command &
      Readonly<{
        enabled: boolean;
        thresholdOverride: number | null;
        expectedSettingsRevision: number;
      }>,
  ): Promise<AutoPauseCommandResult<WorkflowAutoPauseSettings>>;
  resumeWorkflow(
    input: WorkflowScope &
      Command &
      Readonly<{ expectedPauseRevision: string }>,
  ): Promise<AutoPauseCommandResult<WorkflowAutoPauseSettings>>;
  readWorkspaceSettings(input: Scope): Promise<WorkspaceAutoPauseSettings>;
  updateWorkspaceSettings(
    input: Scope &
      Command &
      Readonly<{ threshold: number; expectedRevision: number }>,
  ): Promise<AutoPauseCommandResult<WorkspaceAutoPauseSettings>>;
}

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
