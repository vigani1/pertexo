import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { TriggerPauseEvidence } from '@pertexo/workflow-model';
import { workflows } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';

export async function writeTriggerPause(
  writer: PoolClient | Pick<WorkspaceTransaction, 'db'>,
  {
    workspaceId,
    workflowId,
  }: Readonly<{ workspaceId: string; workflowId: string }>,
  evidence: Readonly<TriggerPauseEvidence & { failures: number }>,
  threshold: number,
) {
  const db = 'db' in writer ? writer.db : drizzle(writer);
  await db
    .update(workflows)
    .set({
      triggerPauseState: 'paused',
      triggerPausedAt: sql`clock_timestamp()`,
      triggerPauseReason: 'consecutive_failures',
      triggerPauseFailures: evidence.failures,
      triggerPauseLastRunId: evidence.kind === 'run' ? evidence.runId : null,
      triggerPausePollTriggerId:
        evidence.kind === 'poll' ? evidence.triggerId : null,
      triggerPausePollErrorCode:
        evidence.kind === 'poll' ? evidence.errorCode : null,
      triggerPauseRevision: sql`${workflows.triggerPauseRevision}+1`,
    })
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  await appendAuditFact(writer, {
    workspaceId,
    action: 'workflow.triggers_paused',
    targetType: 'workflow',
    targetId: workflowId,
    metadata: {
      reason: 'consecutive_failures',
      failures: evidence.failures,
      threshold,
      ...(evidence.kind === 'run'
        ? { lastRunId: evidence.runId }
        : { triggerId: evidence.triggerId, errorCode: evidence.errorCode }),
    },
  });
}
