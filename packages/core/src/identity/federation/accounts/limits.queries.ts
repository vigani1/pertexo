import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authAccounts } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { ACCOUNT_SIGN_IN_METHOD_LIMIT } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

/** The caller locks the user, so every attachment observes the same account bound. */
export async function hasSignInMethodCapacity(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  const [row] = await drizzle(client)
    .select({ count: count() })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId))
    .catch(rethrowQueryFailure);
  const total = row?.count ?? 0;
  return total < ACCOUNT_SIGN_IN_METHOD_LIMIT;
}
