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

const versionFormatSchema = z.union([
  z
    .object({
      schema_version: z.literal(1),
      executable_schema_version: z.null(),
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      executable_schema_version: z.literal(2),
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(2),
      executable_schema_version: z.literal(3),
    })
    .strict(),
]);

/** Summary links in the existing workspace snapshot; retained formats never call native SQL. */
export async function readWorkflowRunCallFamily(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<WorkflowRunCallFamily | undefined> {
  const version = await transaction.db.execute<{
    schema_version: unknown;
    executable_schema_version: unknown;
  }>(sql`
    select version.schema_version,version.executable_schema_version
    from app.workflow_runs run
    left join app.workflow_versions version on version.workspace_id=run.workspace_id
      and version.workflow_id=run.workflow_id and version.id=run.workflow_version_id
    where run.workspace_id=${transaction.workspaceId} and run.id=${runId}
  `);
  if (version.rows.length > 1)
    throw new TypeError('Native run version read is ambiguous');
  if (version.rows.length === 0)
    throw new TypeError('Native run version read missing');
  const format = versionFormatSchema.parse(version.rows[0]);
  if (format.schema_version === 1) return undefined;
  const result = await transaction.db.execute<{ family: unknown }>(sql`
    select app.read_workflow_call_run_family(${runId}::uuid) as family
  `);
  if (result.rows.length !== 1)
    throw new TypeError('Native run family read missing');
  return Object.freeze(familySchema.parse(result.rows[0]?.family));
}
