import type { PoolClient } from 'pg';
import { z } from 'zod';

import { claimCommand, completeCommand } from '../platform/idempotency.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { ROLES, type Role } from '../tenant-access/workspace-policy.js';
import { lockWorkflowAuthoringAuthority } from './workflow-authoring-authority.js';
import { WorkflowNotFoundError } from './workflow-authoring-errors.js';

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

const EDITORS: readonly Role[] = ['owner', 'admin', 'builder'];
const OWNERS: readonly Role[] = ['owner'];

type WorkspaceRow = Readonly<{
  auto_pause_threshold: number;
  revision: number;
}>;
type WorkflowRow = Readonly<{
  auto_pause_enabled: boolean;
  auto_pause_threshold: number | null;
  auto_pause_settings_revision: number;
  trigger_pause_state: 'none' | 'paused';
  trigger_pause_revision: string;
  paused_at: string | null;
  trigger_paused_at: Date | null;
  trigger_pause_reason: 'consecutive_failures' | null;
  trigger_pause_failures: number | null;
  trigger_pause_last_run_id: string | null;
}>;

/**
 * Workspace default edits exclude outcome folds and workflow controls, which
 * take the same key shared.
 */
async function lockWorkspace(
  client: PoolClient,
  workspaceId: string,
  exclusive: boolean,
): Promise<WorkspaceRow> {
  await client.query(
    `select ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1, 0))`,
    [`auto-pause-workspace:${workspaceId}`],
  );
  const workspace = await client.query<WorkspaceRow>(
    `select auto_pause_threshold, revision from app.workspaces
     where id = $1 and status = 'active' for ${exclusive ? 'no key update' : 'share'}`,
    [workspaceId],
  );
  const row = workspace.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Auto pause settings are not visible');
  return row;
}

const WORKFLOW_COLUMNS = `auto_pause_enabled, auto_pause_threshold,
  auto_pause_settings_revision, trigger_pause_state,
  trigger_pause_revision::text trigger_pause_revision, trigger_paused_at,
  to_char(trigger_paused_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') paused_at,
  trigger_pause_reason, trigger_pause_failures, trigger_pause_last_run_id`;

async function lockWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowRow> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `auto-pause-workflow:${workspaceId}:${workflowId}`,
  ]);
  const workflow = await client.query<WorkflowRow>(
    `select ${WORKFLOW_COLUMNS} from app.workflows
     where workspace_id = $1 and id = $2 for no key update`,
    [workspaceId, workflowId],
  );
  const row = workflow.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Auto pause settings are not visible');
  return row;
}

function workflowSettingsOf(
  workflow: WorkflowRow,
  workspace: WorkspaceRow,
): WorkflowAutoPauseSettings {
  return workflowSettings.parse({
    enabled: workflow.auto_pause_enabled,
    thresholdOverride: workflow.auto_pause_threshold,
    workspaceThreshold: workspace.auto_pause_threshold,
    effectiveThreshold:
      workflow.auto_pause_threshold ?? workspace.auto_pause_threshold,
    settingsRevision: workflow.auto_pause_settings_revision,
    pauseState: workflow.trigger_pause_state,
    pauseRevision: workflow.trigger_pause_revision,
    pausedAt: workflow.paused_at,
    pauseReason: workflow.trigger_pause_reason,
    pausedFailures: workflow.trigger_pause_failures,
    pausedLastRunId: workflow.trigger_pause_last_run_id,
  });
}

type CommandInput = Readonly<{
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;

/** All operations share the authoring factory's pool, tracked transactions and close. */
export function createWorkflowAutoPauseStore(
  transact: Transact,
): WorkflowAutoPauseDatabase {
  /**
   * One settings command: the actor's role, then an exact retry's first
   * result, then the change and its audit event when anything changed.
   */
  function command<T>(
    input: CommandInput,
    options: Readonly<{
      /** The workspace lock every auto-pause command takes first. */
      exclusive: boolean;
      operation: string;
      resourceId: string;
      roles: readonly Role[];
      request: unknown;
      schema: z.ZodType<T>;
      apply: (
        client: PoolClient,
        workspace: WorkspaceRow,
      ) => Promise<
        Readonly<{
          settings: T;
          audit?: Readonly<{ action: string; targetType: string }>;
        }>
      >;
    }>,
  ): Promise<AutoPauseCommandResult<T>> {
    const workspaceId = z.uuid().parse(input.workspaceId);
    const actorId = z.uuid().parse(input.actorId);
    return transact(workspaceId, actorId, async (client) => {
      const workspace = await lockWorkspace(
        client,
        workspaceId,
        options.exclusive,
      );
      await lockWorkflowAuthoringAuthority(
        client,
        workspaceId,
        actorId,
        options.roles,
      );
      const identity = {
        workspaceId,
        operation: options.operation,
        scope: `${actorId}:${options.resourceId}`,
        idempotencyKey: input.idempotencyKey,
      };
      const stored = await claimCommand(client, {
        ...identity,
        request: options.request,
        resourceId: options.resourceId,
      });
      if (stored !== null)
        return Object.freeze({
          settings: options.schema.parse(stored),
          replayed: true,
        });
      const { settings, audit } = await options.apply(client, workspace);
      if (audit !== undefined)
        await client.query(
          `insert into app.audit_events
             (id, workspace_id, actor_user_id, action, target_type, target_id,
              request_id, trace_id, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            generatePersistedId(),
            workspaceId,
            actorId,
            audit.action,
            audit.targetType,
            options.resourceId,
            input.requestId ?? null,
            input.traceId ?? null,
            JSON.stringify({ settings }),
          ],
        );
      await completeCommand(client, identity, settings);
      return Object.freeze({ settings, replayed: false });
    });
  }

  return Object.freeze({
    readWorkflowSettings: async (input) => {
      const workspaceId = z.uuid().parse(input.workspaceId),
        actorId = z.uuid().parse(input.actorId),
        workflowId = z.uuid().parse(input.workflowId);
      return transact(workspaceId, actorId, async (client) => {
        const workspace = await lockWorkspace(client, workspaceId, false);
        await lockWorkflowAuthoringAuthority(
          client,
          workspaceId,
          actorId,
          ROLES,
        );
        return workflowSettingsOf(
          await lockWorkflow(client, workspaceId, workflowId),
          workspace,
        );
      });
    },

    readWorkspaceSettings: async (input) => {
      const workspaceId = z.uuid().parse(input.workspaceId),
        actorId = z.uuid().parse(input.actorId);
      return transact(workspaceId, actorId, async (client) => {
        const workspace = await lockWorkspace(client, workspaceId, false);
        await lockWorkflowAuthoringAuthority(
          client,
          workspaceId,
          actorId,
          ROLES,
        );
        return workspaceSettings.parse({
          threshold: workspace.auto_pause_threshold,
          revision: workspace.revision,
        });
      });
    },

    resumeWorkflow: async (input) => {
      const workflowId = z.uuid().parse(input.workflowId);
      const request = {
        expectedPauseRevision: pauseRevision.parse(input.expectedPauseRevision),
      };
      return command(input, {
        operation: 'workflow.autopause.resume',
        resourceId: workflowId,
        roles: EDITORS,
        request,
        schema: workflowSettings,
        exclusive: false,
        apply: async (client, workspace) => {
          const current = await lockWorkflow(
            client,
            input.workspaceId,
            workflowId,
          );
          if (current.trigger_pause_revision !== request.expectedPauseRevision)
            throw new WorkflowPauseRevisionConflictError(
              current.trigger_pause_revision,
            );
          if (current.trigger_pause_state !== 'paused')
            return { settings: workflowSettingsOf(current, workspace) };
          // Outcomes that ended before the resume no longer count.
          const now = await client.query<{ resumed_at: Date }>(
            'select clock_timestamp() resumed_at',
          );
          const resumedAt = now.rows[0]?.resumed_at;
          await client.query(
            `insert into app.workflow_trigger_pause_periods
               (workspace_id, workflow_id, pause_revision, paused_at, resumed_at)
             values ($1, $2, $3, $4, $5)`,
            [
              input.workspaceId,
              workflowId,
              current.trigger_pause_revision,
              current.trigger_paused_at,
              resumedAt,
            ],
          );
          await client.query(
            `insert into app.workflow_failure_streaks
               (workspace_id, workflow_id, consecutive_failures, resumed_after)
             values ($1, $2, 0, $3)
             on conflict on constraint workflow_failure_streaks_pkey do update
             set consecutive_failures = 0, last_run_id = null, last_ended_at = null,
                 resumed_after = $3, updated_at = clock_timestamp()`,
            [input.workspaceId, workflowId, resumedAt],
          );
          const updated = await client.query<WorkflowRow>(
            `update app.workflows
             set trigger_pause_state = 'none', trigger_paused_at = null,
                 trigger_pause_reason = null, trigger_pause_failures = null,
                 trigger_pause_last_run_id = null,
                 trigger_pause_revision = trigger_pause_revision + 1
             where workspace_id = $1 and id = $2
             returning ${WORKFLOW_COLUMNS}`,
            [input.workspaceId, workflowId],
          );
          return {
            settings: workflowSettingsOf(updated.rows[0] ?? current, workspace),
            audit: {
              action: 'workflow.triggers_resumed',
              targetType: 'workflow',
            },
          };
        },
      });
    },

    updateWorkflowSettings: async (input) => {
      const workflowId = z.uuid().parse(input.workflowId);
      const request = {
        enabled: z.boolean().parse(input.enabled),
        thresholdOverride: threshold.nullable().parse(input.thresholdOverride),
        expectedSettingsRevision: revision.parse(
          input.expectedSettingsRevision,
        ),
      };
      return command(input, {
        operation: 'workflow.autopause.settings',
        resourceId: workflowId,
        roles: EDITORS,
        request,
        schema: workflowSettings,
        exclusive: false,
        apply: async (client, workspace) => {
          const current = await lockWorkflow(
            client,
            input.workspaceId,
            workflowId,
          );
          if (
            current.auto_pause_settings_revision !==
            request.expectedSettingsRevision
          )
            throw new WorkflowAutoPauseSettingsRevisionConflictError(
              current.auto_pause_settings_revision,
            );
          if (
            current.auto_pause_enabled === request.enabled &&
            current.auto_pause_threshold === request.thresholdOverride
          )
            return { settings: workflowSettingsOf(current, workspace) };
          const updated = await client.query<WorkflowRow>(
            `update app.workflows
             set auto_pause_enabled = $3, auto_pause_threshold = $4,
                 auto_pause_settings_revision = auto_pause_settings_revision + 1
             where workspace_id = $1 and id = $2
             returning ${WORKFLOW_COLUMNS}`,
            [
              input.workspaceId,
              workflowId,
              request.enabled,
              request.thresholdOverride,
            ],
          );
          return {
            settings: workflowSettingsOf(updated.rows[0] ?? current, workspace),
            audit: {
              action: 'workflow.auto_pause_settings_changed',
              targetType: 'workflow',
            },
          };
        },
      });
    },

    updateWorkspaceSettings: async (input) => {
      const workspaceId = z.uuid().parse(input.workspaceId);
      const request = {
        threshold: threshold.parse(input.threshold),
        expectedRevision: revision.parse(input.expectedRevision),
      };
      return command(input, {
        operation: 'workspace.autopause.settings',
        resourceId: workspaceId,
        roles: OWNERS,
        request,
        schema: workspaceSettings,
        exclusive: true,
        apply: async (client, workspace) => {
          const current = workspace;
          if (current.revision !== request.expectedRevision)
            throw new WorkspaceAutoPauseSettingsRevisionConflictError(
              current.revision,
            );
          if (current.auto_pause_threshold === request.threshold)
            return {
              settings: workspaceSettings.parse({
                threshold: current.auto_pause_threshold,
                revision: current.revision,
              }),
            };
          const updated = await client.query<WorkspaceRow>(
            `update app.workspaces
             set auto_pause_threshold = $2, revision = revision + 1,
                 updated_at = clock_timestamp()
             where id = $1
             returning auto_pause_threshold, revision`,
            [workspaceId, request.threshold],
          );
          const row = updated.rows[0] ?? current;
          return {
            settings: workspaceSettings.parse({
              threshold: row.auto_pause_threshold,
              revision: row.revision,
            }),
            audit: {
              action: 'workspace.auto_pause_settings_changed',
              targetType: 'workspace',
            },
          };
        },
      });
    },
  } satisfies WorkflowAutoPauseDatabase);
}
