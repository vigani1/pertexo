import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../../schema/authoring/workflows.js';
import { workspaces } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';

import { WorkflowNotFoundError } from '../../workflows/errors.js';
import type { WorkflowAutoPauseSettings } from './contract.js';

export const workspaceProjection = {
  autoPauseThreshold: workspaces.autoPauseThreshold,
  revision: workspaces.revision,
};
export const workflowProjection = {
  autoPauseEnabled: workflows.autoPauseEnabled,
  autoPauseThreshold: workflows.autoPauseThreshold,
  autoPauseSettingsRevision: workflows.autoPauseSettingsRevision,
  triggerPauseState: workflows.triggerPauseState,
  triggerPauseRevision: sql<string>`${workflows.triggerPauseRevision}::text`,
  triggerPausedAt: workflows.triggerPausedAt,
  pausedAt: sql<
    string | null
  >`to_char(${workflows.triggerPausedAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  triggerPauseReason: workflows.triggerPauseReason,
  triggerPauseFailures: workflows.triggerPauseFailures,
  triggerPauseLastRunId: workflows.triggerPauseLastRunId,
};
export type WorkspaceRow = Awaited<ReturnType<typeof lockWorkspace>>;
export type WorkflowRow = Awaited<ReturnType<typeof lockWorkflow>>;

/**
 * Workspace default edits exclude outcome folds and workflow controls, which
 * take the same key shared.
 */
export async function lockWorkspace(
  client: PoolClient,
  workspaceId: string,
  {
    exclusive,
    statuses = ['active'],
  }: Readonly<{ exclusive: boolean; statuses?: readonly string[] }>,
) {
  const db = drizzle(client);
  const key = `auto-pause-workspace:${workspaceId}`;
  await db
    .execute(
      exclusive
        ? sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`
        : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key},0))`,
    )
    .catch(rethrowQueryFailure);
  const [row] = await db
    .select(workspaceProjection)
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        sql`${workspaces.status}=any(${sql.param(statuses)}::text[])`,
      ),
    )
    .for(exclusive ? 'no key update' : 'share')
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Auto pause settings are not visible');
  return row;
}

export async function lockWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const db = drizzle(client);
  await db
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`auto-pause-workflow:${workspaceId}:${workflowId}`},0))`,
    )
    .catch(rethrowQueryFailure);
  const [row] = await db
    .select(workflowProjection)
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('no key update')
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Auto pause settings are not visible');
  return row;
}

export function workflowSettingsOf(
  workflow: WorkflowRow,
  workspace: WorkspaceRow,
): WorkflowAutoPauseSettings {
  return {
    enabled: workflow.autoPauseEnabled,
    thresholdOverride: workflow.autoPauseThreshold,
    workspaceThreshold: workspace.autoPauseThreshold,
    effectiveThreshold:
      workflow.autoPauseThreshold ?? workspace.autoPauseThreshold,
    settingsRevision: workflow.autoPauseSettingsRevision,
    pauseState: workflow.triggerPauseState,
    pauseRevision: workflow.triggerPauseRevision,
    pausedAt: workflow.pausedAt,
    pauseReason: workflow.triggerPauseReason,
    pausedFailures: workflow.triggerPauseFailures,
    pausedLastRunId: workflow.triggerPauseLastRunId,
  };
}
