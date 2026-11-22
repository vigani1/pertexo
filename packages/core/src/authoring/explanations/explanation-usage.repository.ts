import { generatePersistedId } from '@pertexo/database/platform';
import { usageEvents } from '@pertexo/database/schema';
import type { ModelUsage } from '@pertexo/node-sdk';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

export async function recordAssistantUsage(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorId: string;
    target:
      | { purpose: 'explain_run'; runId: string }
      | { purpose: 'propose_draft'; workflowId: string };
    requestId: string;
    usage: ModelUsage;
    costNanoDollars: number | null;
  }>,
) {
  await drizzle(client)
    .insert(usageEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      category: 'assistant.model',
      quantity: 1,
      resourceType:
        input.target.purpose === 'explain_run' ? 'workflow-run' : 'workflow',
      resourceId:
        input.target.purpose === 'explain_run'
          ? input.target.runId
          : input.target.workflowId,
      idempotencyKey: `assistant:${input.requestId}`,
      metadata: {
        ...input.usage,
        costNanoDollars: input.costNanoDollars,
        purpose: input.target.purpose,
        actorUserId: input.actorId,
      },
      occurredAt: sql`statement_timestamp()`,
    })
    .onConflictDoNothing({
      target: [usageEvents.workspaceId, usageEvents.idempotencyKey],
    });
}
