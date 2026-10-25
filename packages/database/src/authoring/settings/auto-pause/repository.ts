import {
  ROLES,
  WORKFLOW_EDITOR_ROLES,
  type Role,
} from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { workspaces } from '../../../schema/foundation.js';
import {
  workflowFailureStreaks,
  workflowTriggerPausePeriods,
} from '../../../schema/trigger-pause.js';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';
import { command } from './command.repository.js';

import type { Transact, WorkflowAutoPauseDatabase } from './contract.js';
import {
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkflowPauseRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
} from './errors.js';
import { workflowSettings, workspaceSettings } from './input.js';
import {
  lockWorkflow,
  lockWorkspace,
  workflowProjection,
  workflowSettingsOf,
  workspaceProjection,
} from './state.queries.js';

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

async function readWorkflowPauseSettings(
  transact: Transact,
  input: Parameters<WorkflowAutoPauseDatabase['readWorkflowSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['readWorkflowSettings']> {
  const workspaceId = input.workspaceId,
    actorId = input.actorId,
    workflowId = input.workflowId;
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
  const workspaceId = input.workspaceId,
    actorId = input.actorId;
  return transact(workspaceId, actorId, async (client) => {
    const workspace = await lockWorkspace(client, workspaceId, {
      exclusive: false,
    });
    await lockWorkflowAuthoringAuthority(client, workspaceId, {
      actorId,
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
  input: Parameters<WorkflowAutoPauseDatabase['resumeWorkflow']>[0],
): ReturnType<WorkflowAutoPauseDatabase['resumeWorkflow']> {
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
    schema: workflowSettings,
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
  input: Parameters<WorkflowAutoPauseDatabase['updateWorkflowSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['updateWorkflowSettings']> {
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
    schema: workflowSettings,
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
  input: Parameters<WorkflowAutoPauseDatabase['updateWorkspaceSettings']>[0],
): ReturnType<WorkflowAutoPauseDatabase['updateWorkspaceSettings']> {
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
    schema: workspaceSettings,
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
