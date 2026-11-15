import { canonicalEmail } from './email-policy.js';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { users } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function hasVerifiedAccount(client: PoolClient): Promise<boolean> {
  const [row] = await drizzle(client)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailVerified, true))
    .limit(1)
    .catch(rethrowQueryFailure);
  return row !== undefined;
}

export async function hasPendingInvitation(
  client: PoolClient,
  email: string,
): Promise<boolean> {
  const result = await drizzle(client)
    .execute<{ pending: boolean }>(
      sql`select app.has_pending_invitation(${canonicalEmail(email)}) as pending`,
    )
    .catch(rethrowQueryFailure);
  return result.rows[0]?.pending ?? false;
}

/** Held to commit, so racing first sign-ups admit one at a time. */
export async function lockFirstAccount(client: PoolClient): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended('install-first-account',0))`,
    )
    .catch(rethrowQueryFailure);
}
