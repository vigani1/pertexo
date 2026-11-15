import { workflowVersions, workflowRuns } from '@pertexo/database/schema';
import { and, eq, or, isNull, gt, sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** Each node's stored definition in the version's graph. */
export async function readVersionNodeDefinitions(
  transaction: WorkspaceTransaction,
  input: Readonly<{ workflowId: string; workflowVersionId: string }>,
) {
  const definitions = await transaction.db
    .select({ definition: sql<unknown>`node->'definition'` })
    .from(workflowVersions)
    .crossJoinLateral(
      sql`json_array_elements(${workflowVersions.graphJson}->'nodes') node`,
    )
    .where(
      and(
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.workflowId, input.workflowId),
        eq(workflowVersions.id, input.workflowVersionId),
      ),
    );
  return definitions.map((row) => row.definition);
}

/** The replayed run's version and input, while its input is retained. */
export async function readFormReplaySource(
  transaction: WorkspaceTransaction,
  replaySourceRunId: string | undefined,
) {
  const [original] = await transaction.db
    .select({
      workflow_version_id: workflowRuns.workflowVersionId,
      input_ref: workflowRuns.inputRef,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, sql`${replaySourceRunId ?? null}::uuid`),
        or(
          isNull(workflowRuns.inputRefExpiresAt),
          gt(workflowRuns.inputRefExpiresAt, sql`clock_timestamp()`),
        ),
      ),
    );
  return original;
}
