import type { PoolClient } from 'pg';
import type { PendingTaskOutcome } from '@pertexo/workflow-engine';
import { wakeTaskAncestors } from '../responses/task-responses.repository.js';
import { expireDueTaskRows, storeTimedOutOutput } from './expire.repository.js';
import { timedOutOutput } from './expiry.js';
import { readUnconsumedTaskOutcomes } from './facts.repository.js';

/** Expiry is resolved first; the existing due-node scanner supplies wakeups. */
export async function readPendingTaskFacts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<readonly PendingTaskOutcome[]> {
  const expired = await expireDueTasks(client, workspaceId, runId);
  if (expired > 0) await wakeTaskAncestors(client, workspaceId, runId);
  return readUnconsumedTaskOutcomes(client, workspaceId, runId);
}

/**
 * A task whose step continues on Timed out records its timed-out output in
 * the same transaction. Returns how many tasks expired.
 */
async function expireDueTasks(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<number> {
  const expired = await expireDueTaskRows(client, workspaceId, runId);
  for (const row of expired) {
    const output = timedOutOutput(row);
    if (output === undefined) continue;
    await storeTimedOutOutput(client, { workspaceId, taskId: row.id, output });
  }
  return expired.length;
}
