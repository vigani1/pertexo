import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseSchema } from '@pertexo/database/schema';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import type { Role } from '@pertexo/workflow-model';
import { cancelInTransaction } from '../../runs/commands/cancel-active.repository.js';
import { requireTestCapability } from './access.js';
import type { WorkflowTestRunInput } from './contract.js';
import { readTestDetail } from './records.queries.js';
import { isActiveTestRun } from './rules.js';

export async function cancelWorkflowTest(
  client: PoolClient,
  role: Role,
  input: WorkflowTestRunInput,
): Promise<void> {
  const test = await readTestDetail(client, input);
  if (!isActiveTestRun(test.status)) return;
  requireTestCapability(role, 'run:cancel');
  // The ordinary cancel command appends the fenced observation and outbox wakeup.
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  await cancelInTransaction(transaction, {
    runId: input.runId,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
  });
}
