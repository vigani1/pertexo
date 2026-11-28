import {
  lockAutoPauseWorkspace,
  lockAutoPauseWorkflow,
} from '../../../triggers/pause/locks.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { users, workflows, workspaces } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import type { PoolClient } from 'pg';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { workflowSettings } from './auto-pause-receipts.schemas.js';
import type { WorkflowAutoPauseSettings } from './auto-pause-settings.types.js';

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
  publishedVersionId: workflows.publishedVersionId,
  triggerPausedBy: workflows.triggerPausedBy,
  pausedByName: sql<string | null>`(${new QueryBuilder()
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, workflows.triggerPausedBy))})`,
  pausedAt: sql<
    string | null
  >`to_char(${workflows.triggerPausedAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  triggerPauseReason: workflows.triggerPauseReason,
  triggerPauseFailures: workflows.triggerPauseFailures,
  triggerPauseLastRunId: workflows.triggerPauseLastRunId,
  triggerPausePollTriggerId: workflows.triggerPausePollTriggerId,
  triggerPausePollErrorCode: workflows.triggerPausePollErrorCode,
};
export type WorkspaceRow = NonNullable<
  Awaited<ReturnType<typeof lockWorkspaceSettings>>
>;
export type WorkflowRow = NonNullable<
  Awaited<ReturnType<typeof lockWorkflowSettings>>
>;

/**
 * Workspace default edits exclude outcome folds and workflow controls, which
 * take the same key shared.
 */
export async function lockWorkspaceSettings(
  client: PoolClient,
  workspaceId: string,
  {
    exclusive,
    statuses = ACTIVE_WORKSPACE_STATUSES,
  }: Readonly<{ exclusive: boolean; statuses?: readonly string[] }>,
) {
  const db = drizzle(client);
  await lockAutoPauseWorkspace(client, workspaceId, exclusive);
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
  if (row === undefined) return undefined;
  return row;
}

export async function lockWorkflowSettings(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const db = drizzle(client);
  await lockAutoPauseWorkflow(client, workspaceId, workflowId);
  const [row] = await db
    .select(workflowProjection)
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('no key update')
    .catch(rethrowQueryFailure);
  if (row === undefined) return undefined;
  return row;
}

export function workflowSettingsOf(
  workflow: WorkflowRow,
  workspace: WorkspaceRow,
): WorkflowAutoPauseSettings {
  return decodeStoredValue(() =>
    workflowSettings.parse({
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
      ...(workflow.triggerPausedBy === null
        ? {}
        : {
            pausedBy: {
              id: workflow.triggerPausedBy,
              displayName: workflow.pausedByName,
            },
          }),
      pausedFailures: workflow.triggerPauseFailures,
      pausedLastRunId: workflow.triggerPauseLastRunId,
      ...(workflow.triggerPausePollTriggerId === null ||
      workflow.triggerPausePollErrorCode === null
        ? {}
        : {
            pauseEvidence: {
              kind: 'poll',
              triggerId: workflow.triggerPausePollTriggerId,
              errorCode: workflow.triggerPausePollErrorCode,
            },
          }),
    }),
  );
}
