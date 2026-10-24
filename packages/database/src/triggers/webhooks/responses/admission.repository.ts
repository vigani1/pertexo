import { workflowTriggers } from '../../../schema/authoring/workflows.js';
import { webhookRunResponses as responses } from '../../../schema/triggers/responses.js';
import { CORE_WEBHOOK_CONFIG_SCHEMA } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

export async function openWebhookResponse(
  transaction: WorkspaceTransaction,
  triggerId: string,
  runId: string,
): Promise<number | undefined> {
  const result = await transaction.db
    .select({ desired_config: workflowTriggers.desiredConfig })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, transaction.workspaceId),
        eq(workflowTriggers.id, triggerId),
      ),
    );
  const row = result[0];
  if (row === undefined)
    throw new Error('Accepted webhook trigger is unavailable');
  const config = CORE_WEBHOOK_CONFIG_SCHEMA.parse(row.desired_config);
  if (config.responseMode !== 'workflow') return undefined;
  const seconds = config.responseWaitSeconds ?? 10;
  await transaction.db.insert(responses).values({
    workspaceId: transaction.workspaceId,
    runId,
    waitSeconds: seconds,
  });
  return seconds;
}
export async function webhookReplayWait(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<number | undefined> {
  const result = await transaction.db
    .select({ waitSeconds: responses.waitSeconds })
    .from(responses)
    .where(
      and(
        eq(responses.workspaceId, transaction.workspaceId),
        eq(responses.runId, runId),
      ),
    );
  return result[0]?.waitSeconds;
}
