import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import { runStatusSchema } from './workflow-run-persistence-support.js';

const familySchema = z
  .object({
    rootRunId: z.uuid(),
    parentRunId: z.uuid().nullable(),
    parentInvocationKey: z.string().min(1).max(256).nullable(),
    children: z
      .array(
        z
          .object({
            runId: z.uuid(),
            nodeId: z.string().min(1).max(128),
            invocationKey: z.string().min(1).max(256),
            status: runStatusSchema,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type WorkflowRunCallFamily = Readonly<z.output<typeof familySchema>>;

/** Read-only links in the existing workspace snapshot; retained checkpoints never call native SQL. */
export async function readWorkflowRunCallFamily(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunCallFamily | undefined> {
  const checkpoint = await transaction.db.execute<{ native: boolean }>(sql`
    select scheduler_state->>'schemaVersion'='3' as native
    from app.run_checkpoints
    where workspace_id=${transaction.workspaceId} and workflow_run_id=${runId}
  `);
  if (checkpoint.rows[0]?.native !== true) return undefined;
  const result = await transaction.db.execute<{ family: unknown }>(sql`
    select app.read_workflow_call_run_family(${runId}::uuid) as family
  `);
  if (result.rows.length !== 1)
    throw new TypeError('Native run family read missing');
  return Object.freeze(familySchema.parse(result.rows[0]?.family));
}
