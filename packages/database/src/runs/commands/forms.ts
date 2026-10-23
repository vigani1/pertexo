import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalJson } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { StoredExecutionValue } from '../../platform/stored-execution-value.js';
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
  if (!['manual', 'api', 'replay'].includes(input.triggerType)) return;
  const definitions = await transaction.db.execute<{ definition: unknown }>(
    sql`select node->'definition' definition from app.workflow_versions version cross join lateral json_array_elements(version.graph_json->'nodes') node where version.workspace_id=${transaction.workspaceId} and version.workflow_id=${input.workflowId} and version.id=${input.workflowVersionId}`,
  );
  const entries = z
    .array(z.object({ key: z.string(), version: z.number().int() }).strict())
    .parse(definitions.rows.map((row) => row.definition));
  if (!entries.some(({ key, version }) => key === 'core.form' && version === 1))
    return;
  if (input.triggerType !== 'replay') throw new RunRequiresFormError();
  const source = await transaction.db.execute<{
    workflow_version_id: string;
    input_ref: unknown;
  }>(
    sql`select workflow_version_id,input_ref from app.workflow_runs where workspace_id=${transaction.workspaceId} and id=${input.replaySourceRunId ?? null} and (input_ref_expires_at is null or input_ref_expires_at>clock_timestamp())`,
  );
  const original = source.rows[0];
  const sourceInputChanged =
    original?.workflow_version_id !== input.workflowVersionId ||
    value === undefined ||
    canonicalJson(original.input_ref) !== canonicalJson(value);
  if (sourceInputChanged) throw new RunRequiresFormError();
}
