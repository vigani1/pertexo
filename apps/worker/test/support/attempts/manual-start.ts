import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  acceptWorkflowRun,
  databaseSchema,
  lockManualStartCommand,
  parseWorkspaceId,
  type AcceptWorkflowRunInput,
  type WorkspaceTransaction,
} from '@pertexo/database/testing';

/** Worker fixtures use the same key serialization as manual commands. */
export async function acceptManualFixtureRun(
  transaction: WorkspaceTransaction,
  input: AcceptWorkflowRunInput,
) {
  if (input.triggerType !== 'manual')
    throw new Error('Manual fixture admission requires a manual trigger');
  const scope = `workflow:${input.workflowId}:manual`;
  if (input.scope !== scope)
    throw new Error(
      'Manual fixture command identity must match the canonical scope',
    );
  await lockManualStartCommand(transaction, {
    scope,
    idempotencyKeyHash: input.keyHash,
  });
  return acceptWorkflowRun(transaction, input);
}

/** Direct state fixtures serialize the key in their insertion transaction. */
export async function lockManualFixtureClient(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  keyHash: string,
): Promise<void> {
  await lockManualStartCommand(
    {
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: parseWorkspaceId(workspaceId),
    },
    {
      scope: `workflow:${workflowId}:manual`,
      idempotencyKeyHash: keyHash,
    },
  );
}
