import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { workflowRuns, workflows } from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';

import type { PublishedWorkflow } from '../queries/execution/workflow-execution.types.js';

/** The source run's workflow and its lifecycle, under the database's replay-source lock. */
export async function lockReplaySourceRow(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
) {
  const [source] = await transaction.db
    .select({
      workflowId: sql<string>`source.workflow_id`,
      lifecycleStatus: sql<string>`source.lifecycle_status`,
    })
    .from(
      sql`app.lock_workflow_run_replay_source(${transaction.workspaceId},${sourceRunId}) as source`,
    );
  return source;
}

/** How a run was started, or undefined when it isn't there. */
export async function readRunTriggerType(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<string | undefined> {
  const [run] = await transaction.db
    .select({ triggerType: workflowRuns.triggerType })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
      ),
    );
  return run?.triggerType;
}

export async function findLockedReplayVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  workflowVersionId: string,
): Promise<PublishedWorkflow | null> {
  // The app cannot update immutable version rows; this retained guard owns their share lock.
  const [row] = await transaction.db
    .select({
      id: sql<string>`version.id`,
      workspaceId: sql<string>`version.workspace_id`,
      workflowId: sql<string>`version.workflow_id`,
      versionNumber: sql<number>`version.version_number`,
      checksum: sql<string>`version.checksum`,
      executableJson: sql<unknown>`version.executable_json`,
    })
    .from(
      sql`app.lock_workflow_run_replay_version(${transaction.workspaceId},${workflowId},${workflowVersionId}) as version`,
    );
  return row === undefined ? null : Object.freeze(row);
}

/**
 * The active workflow's published version id, under a share lock taken on the
 * workflow alone: a locked join that waits on a concurrent publication
 * re-checks the new workflow row against the old version row and finds
 * nothing.
 */
export async function shareLockPublishedVersionId(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<string | null | undefined> {
  const [locked] = await transaction.db
    .select({ publishedVersionId: workflows.publishedVersionId })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('share');
  return locked?.publishedVersionId;
}
