import { CORE_WEBHOOK_CONFIG_SCHEMA } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

export async function openWebhookResponse(
  transaction: WorkspaceTransaction,
  triggerId: string,
  runId: string,
): Promise<number | undefined> {
  const result = await transaction.db.execute<{ desired_config: unknown }>(
    sql`select desired_config from app.workflow_triggers where workspace_id=${transaction.workspaceId} and id=${triggerId}`,
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('Accepted webhook trigger is unavailable');
  const config = CORE_WEBHOOK_CONFIG_SCHEMA.parse(row.desired_config);
  if (config.responseMode !== 'workflow') return undefined;
  const seconds = config.responseWaitSeconds ?? 10;
  await transaction.db.execute(
    sql`insert into app.webhook_run_responses(workspace_id,run_id,wait_seconds) values(${transaction.workspaceId},${runId},${seconds})`,
  );
  return seconds;
}
export async function webhookReplayWait(
  transaction: WorkspaceTransaction,
  runId: string,
): Promise<number | undefined> {
  const result = await transaction.db.execute<{ wait_seconds: number }>(
    sql`select wait_seconds from app.webhook_run_responses where workspace_id=${transaction.workspaceId} and run_id=${runId}`,
  );
  return result.rows[0]?.wait_seconds;
}
