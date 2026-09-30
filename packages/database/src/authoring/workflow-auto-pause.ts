import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum } from '../execution/transport/outbox.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';

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
const revision = z.number().int().positive().max(2_147_483_647);
const pauseRevision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const threshold = z.number().int().min(3).max(100);
const workflowSettings = z
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
const workspaceSettings = z.object({ threshold, revision }).strict();
type Transact = <T>(
  workspaceId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/** All operations share the authoring factory's pool, tracked transactions and close. */
export function createWorkflowAutoPauseStore(
  transact: Transact,
): WorkflowAutoPauseDatabase {
  async function call(
    input: Scope & Partial<WorkflowScope> & Partial<Command>,
    operation: string,
    request: Record<string, unknown>,
  ) {
    const workspaceId = z.uuid().parse(input.workspaceId);
    const actorId = z.uuid().parse(input.actorId);
    const workflowId =
      input.workflowId === undefined ? null : z.uuid().parse(input.workflowId);
    const key =
      input.idempotencyKey === undefined
        ? null
        : z
            .string()
            .min(1)
            .max(128)
            .regex(/^[\x21-\x7e]+$/u)
            .refine((value) => !value.includes(','))
            .parse(input.idempotencyKey);
    const requestId = z.string().max(128).optional().parse(input.requestId);
    const traceId = z.string().max(128).optional().parse(input.traceId);
    return transact(workspaceId, actorId, async (client) => {
      try {
        const result = await client.query<{ result: unknown }>(
          'select app.workflow_auto_pause_control($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) as result',
          [
            workspaceId,
            actorId,
            workflowId,
            operation,
            JSON.stringify(request),
            key === null
              ? null
              : createHash('sha256').update(key).digest('hex'),
            key === null
              ? null
              : canonicalOutboxPayloadChecksum({
                  workspaceId,
                  actorId,
                  workflowId,
                  operation,
                  ...request,
                }),
            requestId ?? null,
            traceId ?? null,
          ],
        );
        return result.rows[0]?.result;
      } catch (error: unknown) {
        const pgError = z
          .object({ code: z.string(), detail: z.string().optional() })
          .loose()
          .safeParse(error);
        if (pgError.success) {
          const { code, detail } = pgError.data;
          if (code === 'PT404')
            throw new WorkflowNotFoundError(
              'Auto pause settings are not visible',
            );
          if (code === 'PT409')
            throw new WorkflowIdempotencyConflictError(
              'Auto pause idempotency key was reused',
            );
          if (code === 'PTP09')
            throw new WorkflowPauseRevisionConflictError(
              pauseRevision.parse(detail),
            );
          if (code === 'PTS09')
            throw new WorkflowAutoPauseSettingsRevisionConflictError(
              revision.parse(Number(detail)),
            );
          if (code === 'PTW09')
            throw new WorkspaceAutoPauseSettingsRevisionConflictError(
              revision.parse(Number(detail)),
            );
        }
        throw error;
      }
    });
  }
  return Object.freeze({
    readWorkflowSettings: async (input) =>
      workflowSettings.parse(await call(input, 'read', {})),
    readWorkspaceSettings: async (input) =>
      workspaceSettings.parse(await call(input, 'workspace_read', {})),
    resumeWorkflow: async (input) =>
      z
        .object({ settings: workflowSettings, replayed: z.boolean() })
        .strict()
        .parse(
          await call(input, 'resume', {
            expectedPauseRevision: pauseRevision.parse(
              input.expectedPauseRevision,
            ),
          }),
        ),
    updateWorkflowSettings: async (input) =>
      z
        .object({ settings: workflowSettings, replayed: z.boolean() })
        .strict()
        .parse(
          await call(input, 'settings', {
            enabled: z.boolean().parse(input.enabled),
            thresholdOverride: threshold
              .nullable()
              .parse(input.thresholdOverride),
            expectedSettingsRevision: revision.parse(
              input.expectedSettingsRevision,
            ),
          }),
        ),
    updateWorkspaceSettings: async (input) =>
      z
        .object({ settings: workspaceSettings, replayed: z.boolean() })
        .strict()
        .parse(
          await call(input, 'workspace_settings', {
            threshold: threshold.parse(input.threshold),
            expectedRevision: revision.parse(input.expectedRevision),
          }),
        ),
  } satisfies WorkflowAutoPauseDatabase);
}
