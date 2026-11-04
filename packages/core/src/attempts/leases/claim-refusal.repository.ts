import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { NodeAttemptClaimRefusal } from '../node-attempt.js';
import { NodeAttemptStateCorruptError } from '../node-attempt.errors.js';
import { branchContextSchema } from '../validation/attempt-scope.schemas.js';
import { lockClaimCandidate } from './candidates.repository.js';
import { validateDelivery } from '../completion/receipts.repository.js';

type Candidate = Awaited<ReturnType<typeof lockClaimCandidate>>['row'];

export function readyClaimScope(
  row: Candidate,
): z.output<typeof branchContextSchema> {
  if (row.attemptStatus !== 'ready' || row.nodeStatus !== 'ready')
    throw new NodeAttemptStateCorruptError();
  if (row.branchContext === null) return {};
  const parsed = branchContextSchema.safeParse(row.branchContext);
  if (!parsed.success) throw new NodeAttemptStateCorruptError();
  return parsed.data;
}

/** No lease was acquired: the same unclaimed fence must still hold corrupt state. */
export async function isCurrentClaimRefusal(
  client: PoolClient,
  report: NodeAttemptClaimRefusal,
): Promise<boolean> {
  await validateDelivery(client, report);
  let candidate;
  try {
    candidate = await lockClaimCandidate(client, report);
  } catch (error) {
    if (error instanceof NodeAttemptStateCorruptError) return false;
    throw error;
  }
  const { row, runRow } = candidate;
  if (
    runRow.checkpointRevision !== report.checkpointRevision ||
    row.fenceToken !== report.fenceToken ||
    row.attemptStatus !== 'ready'
  )
    return false;
  try {
    readyClaimScope(row);
    return false;
  } catch (error) {
    if (error instanceof NodeAttemptStateCorruptError) return true;
    throw error;
  }
}
