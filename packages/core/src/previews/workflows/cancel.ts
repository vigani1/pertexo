import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseSchema } from '@pertexo/database/schema';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { rolesForCapability } from '@pertexo/workflow-model';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { cancelInTransaction } from '../../runs/commands/cancel-active.repository.js';
import { readTestDetail } from './records.queries.js';

export async function cancelWorkflowTest(
  client: PoolClient,
  input: SampleScope & Readonly<{ runId: string }>,
): Promise<void> {
  const test = await readTestDetail(client, input);
  if (!['queued', 'running', 'waiting'].includes(test.status)) return;
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability('run:cancel'),
  });
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
