import type { PoolClient } from 'pg';

import { WorkflowNotFoundError } from '../../workflows/errors.js';
import {
  type WorkflowAutoPauseSettings,
  workflowSettings,
} from './contract.js';

export type WorkspaceRow = Readonly<{
  auto_pause_threshold: number;
  revision: number;
}>;

export type WorkflowRow = Readonly<{
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
export async function lockWorkspace(
  client: PoolClient,
  workspaceId: string,
  { exclusive }: Readonly<{ exclusive: boolean }>,
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

export const WORKFLOW_COLUMNS = `auto_pause_enabled, auto_pause_threshold,
  auto_pause_settings_revision, trigger_pause_state,
  trigger_pause_revision::text trigger_pause_revision, trigger_paused_at,
  to_char(trigger_paused_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') paused_at,
  trigger_pause_reason, trigger_pause_failures, trigger_pause_last_run_id`;

export async function lockWorkflow(
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

export function workflowSettingsOf(
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
