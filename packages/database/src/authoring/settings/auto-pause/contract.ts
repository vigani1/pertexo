import type { PoolClient } from 'pg';
import { z } from 'zod';

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

export interface WorkflowAutoPauseDatabase {
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

export class WorkflowPauseRevisionConflictError extends Error {
  public override readonly name = 'WorkflowPauseRevisionConflictError';
  public constructor(public readonly currentRevision: string) {
    super('Workflow pause revision does not match');
  }
}

export class WorkflowAutoPauseSettingsRevisionConflictError extends Error {
  public override readonly name =
    'WorkflowAutoPauseSettingsRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workflow auto pause settings revision does not match');
  }
}

export class WorkspaceAutoPauseSettingsRevisionConflictError extends Error {
  public override readonly name =
    'WorkspaceAutoPauseSettingsRevisionConflictError';
  public constructor(public readonly currentRevision: number) {
    super('Workspace auto pause settings revision does not match');
  }
}

export const revision = z.number().int().positive().max(2_147_483_647);

export const pauseRevision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

export const threshold = z.number().int().min(3).max(100);

export const workflowSettings = z
  .object({
    enabled: z.boolean(),
    thresholdOverride: threshold.nullable(),
    workspaceThreshold: threshold,
    effectiveThreshold: threshold,
    settingsRevision: revision,
    pauseState: z.enum(['none', 'paused']),
    pauseRevision,
    pausedAt: z.iso.datetime({ precision: 6 }).nullable(),
    pauseReason: z.literal('consecutive_failures').nullable(),
    pausedFailures: z.number().int().positive().nullable(),
    pausedLastRunId: z.uuid().nullable(),
  })
  .strict();

export const workspaceSettings = z.object({ threshold, revision }).strict();

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
