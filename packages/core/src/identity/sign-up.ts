import { canonicalEmail } from '@pertexo/workflow-model';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { users } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { withPlatformTransaction } from '@pertexo/database/platform';

/** `invitation` closes sign-up once the install has its first verified account. */
export type SignUpMode = 'invitation' | 'open';

async function hasVerifiedAccount(client: PoolClient): Promise<boolean> {
  const [row] = await drizzle(client)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailVerified, true))
    .limit(1)
    .catch(rethrowQueryFailure);
  return row !== undefined;
}

async function hasPendingInvitation(
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

async function admits(
  client: PoolClient,
  mode: SignUpMode,
  email: string,
): Promise<boolean> {
  return (
    mode === 'open' ||
    !(await hasVerifiedAccount(client)) ||
    hasPendingInvitation(client, email)
  );
}

/**
 * Decides whether this address may become a working account, inside the
 * transaction that makes it one. Held to commit, the lock is what leaves one
 * winner when several people race to be an install's first account.
 */
export async function admitNewAccount(
  client: PoolClient,
  mode: SignUpMode,
  email: string,
): Promise<boolean> {
  if (mode === 'open') return true;
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended('install-first-account',0))`,
    )
    .catch(rethrowQueryFailure);
  return admits(client, mode, email);
}

/** What a form can tell someone before they fill it in; verification decides for real. */
export class SignUpAvailability {
  public constructor(
    private readonly pool: Pool,
    private readonly mode: SignUpMode,
  ) {}

  public admits(email: string): Promise<boolean> {
    return withPlatformTransaction(this.pool, (client) =>
      admits(client, this.mode, email),
    );
  }

  public async availableToEveryone(): Promise<boolean> {
    return (
      this.mode === 'open' ||
      !(await withPlatformTransaction(this.pool, hasVerifiedAccount))
    );
  }
}
