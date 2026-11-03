import { and, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { authVerifications } from '@pertexo/database/schema';

/** The caller holds the user lock, so sibling resets cannot outlive this change. */
export async function invalidatePasswordResetProofs(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await drizzle(client)
    .delete(authVerifications)
    .where(
      and(
        eq(authVerifications.value, userId),
        like(authVerifications.identifier, 'reset-password:%'),
      ),
    );
}
