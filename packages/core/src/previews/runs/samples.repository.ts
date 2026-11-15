import { and, eq } from 'drizzle-orm';
import { workflowStepSamples } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

export async function lockStepSample(
  transaction: WorkspaceTransaction,
  input: Readonly<{ workflowId: string; nodeId: string }>,
) {
  const rows = await transaction.db
    .select()
    .from(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, transaction.workspaceId),
        eq(workflowStepSamples.workflowId, input.workflowId),
        eq(workflowStepSamples.nodeId, input.nodeId),
      ),
    )
    .for('share')
    .limit(1);
  return rows[0];
}
