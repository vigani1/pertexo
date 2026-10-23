import { ACCOUNT_SIGN_IN_METHOD_LIMIT } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

/** The caller locks the user, so every attachment observes the same account bound. */
export async function hasSignInMethodCapacity(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  const count =
    (
      await client.query<{ count: number }>(
        'select count(*)::integer as count from app.auth_accounts where user_id=$1',
        [userId],
      )
    ).rows[0]?.count ?? 0;
  return count < ACCOUNT_SIGN_IN_METHOD_LIMIT;
}
