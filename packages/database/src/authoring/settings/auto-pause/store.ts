import { WORKFLOW_EDITOR_ROLES } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {claimCommand, completeCommand} from '../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { ROLES, type Role } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';

import {
  type AutoPauseCommandResult,
  type WorkflowAutoPauseDatabase,
  WorkflowPauseRevisionConflictError,
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
  revision,
  pauseRevision,
  threshold,
  workflowSettings,
  workspaceSettings,
  type Transact,
  type CommandInput,
} from './contract.js';
import {
  type WorkspaceRow,
  type WorkflowRow,
  lockWorkspace,
  WORKFLOW_COLUMNS,
  lockWorkflow,
  workflowSettingsOf,
} from './state.queries.js';

export {
  type WorkflowAutoPauseSettings,
  type WorkspaceAutoPauseSettings,
  type AutoPauseCommandResult,
  type WorkflowAutoPauseDatabase,
  WorkflowPauseRevisionConflictError,
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
} from './contract.js';
const EDITORS: readonly Role[] = WORKFLOW_EDITOR_ROLES;

const OWNERS: readonly Role[] = ['owner'];

/** All operations share the authoring factory's pool, tracked transactions and close. */
export function createWorkflowAutoPauseStore(
  transact: Transact,
): WorkflowAutoPauseDatabase {
  return Object.freeze({
    readWorkflowSettings: (input) => readWorkflowPauseSettings(transact, input),

    readWorkspaceSettings: (input) =>
      readWorkspacePauseSettings(transact, input),

    resumeWorkflow: (input) => resumePausedWorkflow(transact, input),

    updateWorkflowSettings: (input) =>
      updateWorkflowPauseSettings(transact, input),

    updateWorkspaceSettings: (input) =>
      updateWorkspacePauseSettings(transact, input),
  } satisfies WorkflowAutoPauseDatabase);
}

/**
 * One settings command: the actor's role, then an exact retry's first
 * result, then the change and its audit event when anything changed.
 */
function command<T>(
  transact: Transact,
  input: CommandInput,
  options: Readonly<{
    /** The workspace lock every auto-pause command takes first. */
    exclusive: boolean;
    operation: string;
    resourceId: string;
    workflowId?: string;
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
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: options.exclusive,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
      roles: options.roles,
      resource:
        options.workflowId === undefined
          ? undefined
          : { workflowId: options.workflowId, capability: 'workflow:update' },
    });
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
async function readWorkflowPauseSettings(
  transact: Transact,
  input: Parameters<WorkflowAutoPauseDatabase['readWorkflowSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['readWorkflowSettings']> {
  const workspaceId = z.uuid().parse(input.workspaceId),
    actorId = z.uuid().parse(input.actorId),
    workflowId = z.uuid().parse(input.workflowId);
  return transact(workspaceId, actorId, async (client) => {
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: false,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
      roles: ROLES,
      resource: {
        workflowId,
        capability: 'workflow:read',
      },
    });
    return workflowSettingsOf(
      await lockWorkflow(client, workspaceId, workflowId),
      workspace,
    );
  });
}

async function readWorkspacePauseSettings(
  transact: Transact,
  input: Parameters<WorkflowAutoPauseDatabase['readWorkspaceSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['readWorkspaceSettings']> {
  const workspaceId = z.uuid().parse(input.workspaceId),
    actorId = z.uuid().parse(input.actorId);
  return transact(workspaceId, actorId, async (client) => {
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: false,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
      roles: ROLES,
    });
    return workspaceSettings.parse({
      threshold: workspace.auto_pause_threshold,
      revision: workspace.revision,
    });
  });
}

async function resumePausedWorkflow(
  transact: Transact,
  input: Parameters<WorkflowAutoPauseDatabase['resumeWorkflow']>[0],
): ReturnType<WorkflowAutoPauseDatabase['resumeWorkflow']> {
  const workflowId = z.uuid().parse(input.workflowId);
  const request = {
    expectedPauseRevision: pauseRevision.parse(input.expectedPauseRevision),
  };
  return command(transact, input, {
    operation: 'workflow.autopause.resume',
    resourceId: workflowId,
    workflowId,
    roles: EDITORS,
    request,
    schema: workflowSettings,
    exclusive: false,
    apply: async (client, workspace) => {
      const current = await lockWorkflow(client, input.workspaceId, workflowId);
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
}

async function updateWorkflowPauseSettings(
  transact: Transact,
  input: Parameters<WorkflowAutoPauseDatabase['updateWorkflowSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['updateWorkflowSettings']> {
  const workflowId = z.uuid().parse(input.workflowId);
  const request = {
    enabled: z.boolean().parse(input.enabled),
    thresholdOverride: threshold.nullable().parse(input.thresholdOverride),
    expectedSettingsRevision: revision.parse(input.expectedSettingsRevision),
  };
  return command(transact, input, {
    operation: 'workflow.autopause.settings',
    resourceId: workflowId,
    workflowId,
    roles: EDITORS,
    request,
    schema: workflowSettings,
    exclusive: false,
    apply: async (client, workspace) => {
      const current = await lockWorkflow(client, input.workspaceId, workflowId);
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
}

async function updateWorkspacePauseSettings(
  transact: Transact,
  input: Parameters<WorkflowAutoPauseDatabase['updateWorkspaceSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['updateWorkspaceSettings']> {
  const workspaceId = z.uuid().parse(input.workspaceId);
  const request = {
    threshold: threshold.parse(input.threshold),
    expectedRevision: revision.parse(input.expectedRevision),
  };
  return command(transact, input, {
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
}
