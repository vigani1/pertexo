import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { workflowSettings } from './auto-pause-receipts.schemas.js';

export type WorkflowAutoPauseSettings = Readonly<
  z.output<typeof workflowSettings>
>;

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
  commandCredentialId?: string;
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
export type ChangeWorkflowPauseInput = WorkflowAutoPauseScope &
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
  commandCredentialId?: string;
  requestId?: string;
  traceId?: string;
}>;
