import { z } from 'zod';

export class OperatorCommandConflictError extends Error {
  public constructor() {
    super('Operator command replay conflicts with the existing request');
    this.name = 'OperatorCommandConflictError';
  }
}

interface CommandInput {
  actorRef: string;
  commandId: string;
  dryRun: boolean;
  reason: string;
  workspaceId: string;
  signal?: AbortSignal | undefined;
}

export type RedispatchInput = CommandInput &
  Readonly<{ outboxEventId: string }>;
export type ReconcileAttemptInput = CommandInput &
  Readonly<{
    action: 'outcome_unknown' | 'reclaim';
    attemptId: string;
    expectedFenceToken: number;
  }>;
export type TargetRunInput = CommandInput & Readonly<{ runId: string }>;
export type TargetWorkflowInput = CommandInput &
  Readonly<{ workflowId: string }>;
export type ReplayRunInput = CommandInput &
  Readonly<{
    runInput: unknown;
    sourceRunId: string;
    workflowVersionId: string;
  }>;
export type UnknownEvidenceInput = Omit<CommandInput, 'dryRun'> &
  Readonly<{
    attemptId: string;
    evidenceKind: string;
    evidenceRef: Readonly<Record<string, unknown>>;
  }>;
export type GetCommandInput = Omit<CommandInput, 'dryRun'>;

export interface Options {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

// These constructor options have no upstream configuration parser.
export const optionsSchema = z.object({
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});
