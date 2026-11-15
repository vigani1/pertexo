import { readDatabaseClock } from '../shared/database-clock.repository.js';
import { randomUUID } from 'node:crypto';
import { canonicalEmail } from './email-policy.js';
import { withPlatformTransaction } from '@pertexo/database/platform';
import {
  insertSystemMail,
  type SystemMailInput,
} from '@pertexo/secrets/server';
import { canonicalEmailSql } from './canonical-email.repository.js';
import { and, eq, like, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import {
  authVerifications,
  authAccounts,
  users,
} from '@pertexo/database/schema';

const PASSWORD_RESET_LIFETIME_HOURS = 1;
const PASSWORD_RESET_LIFETIME_MILLIS =
  PASSWORD_RESET_LIFETIME_HOURS * 60 * 60 * 1_000;

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

/** No workspace exists here: issuance shares the user fence with credential changes. */
export async function issuePasswordResetProof(
  pool: Pool,
  input: Readonly<{
    email: string;
    token: string;
    prepareMail: (
      recipient: Readonly<{ email: string; displayName: string }>,
      expiresAt: Date,
    ) => SystemMailInput | undefined;
  }>,
) {
  return withPlatformTransaction(pool, async (client) => {
    const db = drizzle(client);
    const [user] = await db
      .select()
      .from(users)
      .where(eq(canonicalEmailSql(users.email), canonicalEmail(input.email)))
      .for('update');
    if (
      user?.status !== 'active' ||
      canonicalEmail(user.email) !== canonicalEmail(input.email)
    )
      return undefined;
    const [credential] = await db
      .select({ password: authAccounts.password })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, user.id),
          eq(authAccounts.providerId, 'credential'),
        ),
      )
      .for('update');
    if (credential?.password == null) return undefined;
    const expiresAt = new Date(
      (await readDatabaseClock(db)).getTime() + PASSWORD_RESET_LIFETIME_MILLIS,
    );
    const recipient = { email: user.email, displayName: user.displayName };
    const prepared = input.prepareMail(recipient, expiresAt);
    await db.insert(authVerifications).values({
      id: randomUUID(),
      identifier: `reset-password:${input.token}`,
      value: user.id,
      expiresAt,
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    });
    if (prepared !== undefined) await insertSystemMail(client, prepared);
    return { recipient, queued: prepared !== undefined };
  });
}
