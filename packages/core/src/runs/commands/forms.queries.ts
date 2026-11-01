import { workflowVersions, workflowRuns } from '@pertexo/database/schema';
import { and, eq, or, isNull, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  requiresFormAdmissionCheck,
  formAdmissionRequirement,
  capturedFormReplayMatches,
} from '@pertexo/workflow-model';
import type {
  WorkspaceTransaction,
  StoredExecutionValue,
} from '@pertexo/database/primitives';
export class RunRequiresFormError extends Error {
  override readonly name = 'RunRequiresFormError';
}

/** A replay may repeat a captured submission, never invent its server-owned actor or time. */
export async function requireFormAdmission(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    triggerType: string;
    workflowId: string;
    workflowVersionId: string;
    replaySourceRunId?: string | undefined;
  }>,
  value: StoredExecutionValue | undefined,
): Promise<void> {
  if (!requiresFormAdmissionCheck(input.triggerType)) return;
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
  const entries = z
    .array(z.object({ key: z.string(), version: z.number().int() }).strict())
    .parse(definitions.map((row) => row.definition));
  const requirement = formAdmissionRequirement(entries, input.triggerType);
  if (requirement === 'allow') return;
  if (requirement === 'refuse') throw new RunRequiresFormError();
  const [original] = await transaction.db
    .select({
      workflow_version_id: workflowRuns.workflowVersionId,
      input_ref: workflowRuns.inputRef,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, sql`${input.replaySourceRunId ?? null}::uuid`),
        or(
          isNull(workflowRuns.inputRefExpiresAt),
          gt(workflowRuns.inputRefExpiresAt, sql`clock_timestamp()`),
        ),
      ),
    );
  const matches = capturedFormReplayMatches(
    original === undefined
      ? undefined
      : {
          workflowVersionId: original.workflow_version_id,
          inputRef: original.input_ref,
        },
    input.workflowVersionId,
    value,
  );
  if (!matches) throw new RunRequiresFormError();
}
