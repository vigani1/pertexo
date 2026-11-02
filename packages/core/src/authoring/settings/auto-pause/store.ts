import {
  ROLES,
  WORKFLOW_EDITOR_ROLES,
  type Role,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflows,
  workspaces,
  workflowFailureStreaks,
  workflowTriggerPausePeriods,
} from '@pertexo/database/schema';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import { command } from './command.repository.js';

import type {
  AutoPauseCommandResult,
  ResumeWorkflowInput,
  Transact,
  UpdateWorkflowAutoPauseInput,
  UpdateWorkspaceAutoPauseInput,
  WorkflowAutoPauseScope,
  WorkflowAutoPauseSettings,
  WorkspaceAutoPauseScope,
  WorkspaceAutoPauseSettings,
} from './contract.js';
import {
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkflowPauseRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
} from './errors.js';
import {
  lockWorkflow,
  lockWorkspace,
  workflowProjection,
  workflowSettingsOf,
  workspaceProjection,
} from './state.queries.js';

const EDITORS: readonly Role[] = WORKFLOW_EDITOR_ROLES;

const OWNERS: readonly Role[] = ['owner'];

export type WorkflowAutoPauseStore = ReturnType<
  typeof createWorkflowAutoPauseStore
>;

/**
 * All operations share the authoring factory's pool, tracked transactions and
 * close, and stay off `withWorkspaceAccess`: `lockWorkspace` takes an advisory key
 * and the workspace row `NO KEY UPDATE` before authority. Behind the helper's share
 * lock, a reader would hold the row and wait on the key, while a threshold edit
 * holds the key and waits on the row: 40P01.
 */
export function createWorkflowAutoPauseStore(transact: Transact) {
  return Object.freeze({
    readWorkflowSettings: (input: WorkflowAutoPauseScope) =>
      readWorkflowPauseSettings(transact, input),
    readWorkspaceSettings: (input: WorkspaceAutoPauseScope) =>
      readWorkspacePauseSettings(transact, input),
    resumeWorkflow: (input: ResumeWorkflowInput) =>
      resumePausedWorkflow(transact, input),
    updateWorkflowSettings: (input: UpdateWorkflowAutoPauseInput) =>
      updateWorkflowPauseSettings(transact, input),
    updateWorkspaceSettings: (input: UpdateWorkspaceAutoPauseInput) =>
      updateWorkspacePauseSettings(transact, input),
  });
}

async function readWorkflowPauseSettings(
  transact: Transact,
  input: WorkflowAutoPauseScope,
): Promise<WorkflowAutoPauseSettings> {
  const workspaceId = input.workspaceId,
    actorId = input.actorId,
    workflowId = input.workflowId;
  return transact(workspaceId, actorId, async (client) => {
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: false,
      statuses: BROWSABLE_WORKSPACE_STATUSES,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
      browsing: true,
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
  input: WorkspaceAutoPauseScope,
): Promise<WorkspaceAutoPauseSettings> {
  const workspaceId = input.workspaceId,
    actorId = input.actorId;
  return transact(workspaceId, actorId, async (client) => {
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: false,
      statuses: BROWSABLE_WORKSPACE_STATUSES,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
      browsing: true,
      roles: ROLES,
    });
    return {
      threshold: workspace.autoPauseThreshold,
      revision: workspace.revision,
    };
  });
}

async function resumePausedWorkflow(
  transact: Transact,
  input: ResumeWorkflowInput,
): Promise<AutoPauseCommandResult<WorkflowAutoPauseSettings>> {
  const workflowId = input.workflowId;
  const request = {
    expectedPauseRevision: input.expectedPauseRevision,
  };
  return command(transact, input, {
    operation: 'workflow.autopause.resume',
    resourceId: workflowId,
    workflowId,
    roles: EDITORS,
    request,
    exclusive: false,
    apply: async (client, workspace) => {
      const current = await lockWorkflow(client, input.workspaceId, workflowId);
      if (current.triggerPauseRevision !== request.expectedPauseRevision)
        throw new WorkflowPauseRevisionConflictError(
          current.triggerPauseRevision,
        );
      if (current.triggerPauseState !== 'paused')
        return { settings: workflowSettingsOf(current, workspace) };
      // Outcomes that ended before the resume no longer count.
      const db = drizzle(client);
      const now = await db
        .execute<{ resumed_at: string }>(
          sql`select clock_timestamp() resumed_at`,
        )
        .catch(rethrowQueryFailure);
      const clock = now.rows[0]?.resumed_at;
      if (clock === undefined) throw new Error('Resume time is unavailable');
      const resumedAt = new Date(clock).toISOString();
      // The paused-state CHECK guarantees the retained pause start is present.
      await db
        .insert(workflowTriggerPausePeriods)
        .values({
          workspaceId: input.workspaceId,
          workflowId,
          pauseRevision: BigInt(current.triggerPauseRevision),
          pausedAt: sql<string>`${current.triggerPausedAt}::timestamptz`,
          resumedAt,
        })
        .catch(rethrowQueryFailure);
      await db
        .insert(workflowFailureStreaks)
        .values({
          workspaceId: input.workspaceId,
          workflowId,
          consecutiveFailures: 0,
          resumedAfter: resumedAt,
        })
        .onConflictDoUpdate({
          target: [
            workflowFailureStreaks.workspaceId,
            workflowFailureStreaks.workflowId,
          ],
          set: {
            consecutiveFailures: 0,
            lastRunId: null,
            lastEndedAt: null,
            resumedAfter: resumedAt,
            updatedAt: sql`clock_timestamp()`,
          },
        })
        .catch(rethrowQueryFailure);
      const [updated] = await db
        .update(workflows)
        .set({
          triggerPauseState: 'none',
          triggerPausedAt: null,
          triggerPauseReason: null,
          triggerPauseFailures: null,
          triggerPauseLastRunId: null,
          triggerPauseRevision: sql`${workflows.triggerPauseRevision}+1`,
        })
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            eq(workflows.id, workflowId),
          ),
        )
        .returning(workflowProjection)
        .catch(rethrowQueryFailure);
      return {
        settings: workflowSettingsOf(updated ?? current, workspace),
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
  input: UpdateWorkflowAutoPauseInput,
): Promise<AutoPauseCommandResult<WorkflowAutoPauseSettings>> {
  const workflowId = input.workflowId;
  const request = {
    enabled: input.enabled,
    thresholdOverride: input.thresholdOverride,
    expectedSettingsRevision: input.expectedSettingsRevision,
  };
  return command(transact, input, {
    operation: 'workflow.autopause.settings',
    resourceId: workflowId,
    workflowId,
    roles: EDITORS,
    request,
    exclusive: false,
    apply: async (client, workspace) => {
      const current = await lockWorkflow(client, input.workspaceId, workflowId);
      if (
        current.autoPauseSettingsRevision !== request.expectedSettingsRevision
      )
        throw new WorkflowAutoPauseSettingsRevisionConflictError(
          current.autoPauseSettingsRevision,
        );
      if (
        current.autoPauseEnabled === request.enabled &&
        current.autoPauseThreshold === request.thresholdOverride
      )
        return { settings: workflowSettingsOf(current, workspace) };
      const [updated] = await drizzle(client)
        .update(workflows)
        .set({
          autoPauseEnabled: request.enabled,
          autoPauseThreshold: request.thresholdOverride,
          autoPauseSettingsRevision: sql`${workflows.autoPauseSettingsRevision}+1`,
        })
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            eq(workflows.id, workflowId),
          ),
        )
        .returning(workflowProjection)
        .catch(rethrowQueryFailure);
      return {
        settings: workflowSettingsOf(updated ?? current, workspace),
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
  input: UpdateWorkspaceAutoPauseInput,
): Promise<AutoPauseCommandResult<WorkspaceAutoPauseSettings>> {
  const workspaceId = input.workspaceId;
  const request = {
    threshold: input.threshold,
    expectedRevision: input.expectedRevision,
  };
  return command(transact, input, {
    operation: 'workspace.autopause.settings',
    resourceId: workspaceId,
    roles: OWNERS,
    request,
    exclusive: true,
    apply: async (client, workspace) => {
      const current = workspace;
      if (current.revision !== request.expectedRevision)
        throw new WorkspaceAutoPauseSettingsRevisionConflictError(
          current.revision,
        );
      if (current.autoPauseThreshold === request.threshold)
        return {
          settings: {
            threshold: current.autoPauseThreshold,
            revision: current.revision,
          },
        };
      const [updated] = await drizzle(client)
        .update(workspaces)
        .set({
          autoPauseThreshold: request.threshold,
          revision: sql`${workspaces.revision}+1`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(workspaces.id, workspaceId))
        .returning(workspaceProjection)
        .catch(rethrowQueryFailure);
      const row = updated ?? current;
      return {
        settings: {
          threshold: row.autoPauseThreshold,
          revision: row.revision,
        },
        audit: {
          action: 'workspace.auto_pause_settings_changed',
          targetType: 'workspace',
        },
      };
    },
  });
}
