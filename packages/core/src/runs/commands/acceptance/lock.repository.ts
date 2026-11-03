import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

/** The HTTP command checks authority before serializing this workspace's key. */
export async function lockRunAcceptanceCommand(
  transaction: WorkspaceTransaction,
  identity: Readonly<{ scope: string; idempotencyKeyHash: string }>,
): Promise<void> {
  // Retain the namespace so deployed manual starts serialize with new callers.
  const key = `pertexo.manual-start:${transaction.workspaceId}:workflow.run.accept:${identity.scope}:${identity.idempotencyKeyHash}`;
  await transaction.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 1934781131))`,
  );
}
