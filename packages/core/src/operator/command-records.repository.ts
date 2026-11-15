import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { operatorCommands } from '@pertexo/database/schema';
import { eq, sql } from 'drizzle-orm';

import type { OperatorDecision } from './handlers/decision.js';
import type { CommandRequest } from './operator-command.types.js';

/** Seed of the advisory lock that serializes requests reusing one command id. */
const COMMAND_LOCK_SEED = 7_166_118_813;

export async function setLockTimeout(
  transaction: WorkspaceTransaction,
  lockTimeoutMs: number,
): Promise<void> {
  await transaction.db.execute(
    sql`select set_config('lock_timeout', ${String(lockTimeoutMs)}, true)`,
  );
}

export async function lockCommandId(
  transaction: WorkspaceTransaction,
  commandId: string,
): Promise<void> {
  await transaction.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${commandId}, ${COMMAND_LOCK_SEED}))`,
  );
}

export async function readCommandOutcome(
  transaction: WorkspaceTransaction,
  commandId: string,
) {
  const [existing] = await transaction.db
    .select({
      outcome: operatorCommands.outcome,
      requestFingerprint: operatorCommands.requestFingerprint,
      result: operatorCommands.result,
      status: operatorCommands.status,
    })
    .from(operatorCommands)
    .where(eq(operatorCommands.id, commandId));
  return existing;
}

export async function insertCommandOutcome(
  transaction: WorkspaceTransaction,
  request: CommandRequest,
  outcome: Readonly<{
    fingerprint: string;
    status: 'pending' | 'completed';
    decision: OperatorDecision;
  }>,
): Promise<void> {
  await transaction.db.insert(operatorCommands).values({
    id: request.commandId,
    workspaceId: transaction.workspaceId,
    commandType: request.commandType,
    dryRun: request.dryRun,
    requestFingerprint: outcome.fingerprint,
    status: outcome.status,
    outcome: outcome.decision.outcome,
    result: outcome.decision.result,
    completedAt: outcome.status === 'pending' ? null : sql`clock_timestamp()`,
  });
}
