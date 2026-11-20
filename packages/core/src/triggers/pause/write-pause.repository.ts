import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';

export async function writeTriggerPause(
  client: PoolClient,
  {
    workspaceId,
    workflowId,
  }: Readonly<{ workspaceId: string; workflowId: string }>,
  evidence: Readonly<{ failures: number; runId: string }>,
  threshold: number,
) {
  const db = drizzle(client);
  await db
    .update(workflows)
    .set({
      triggerPauseState: 'paused',
      triggerPausedAt: sql`clock_timestamp()`,
      triggerPauseReason: 'consecutive_failures',
      triggerPauseFailures: evidence.failures,
      triggerPauseLastRunId: evidence.runId,
      triggerPauseRevision: sql`${workflows.triggerPauseRevision}+1`,
    })
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  await appendAuditFact(client, {
    workspaceId,
    action: 'workflow.triggers_paused',
    targetType: 'workflow',
    targetId: workflowId,
    metadata: {
      reason: 'consecutive_failures',
      failures: evidence.failures,
      threshold,
      lastRunId: evidence.runId,
    },
  });
}
