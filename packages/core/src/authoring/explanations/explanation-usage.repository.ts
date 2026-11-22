import { generatePersistedId } from '@pertexo/database/platform';
import { usageEvents } from '@pertexo/database/schema';
import type { ModelUsage } from '@pertexo/node-sdk';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

export async function recordExplanationUsage(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorId: string;
    runId: string;
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
      resourceType: 'workflow-run',
      resourceId: input.runId,
      idempotencyKey: `assistant:${input.requestId}`,
      metadata: {
        ...input.usage,
        costNanoDollars: input.costNanoDollars,
        purpose: 'explain_run',
        actorUserId: input.actorId,
      },
      occurredAt: sql`statement_timestamp()`,
    })
    .onConflictDoNothing({
      target: [usageEvents.workspaceId, usageEvents.idempotencyKey],
    });
}
