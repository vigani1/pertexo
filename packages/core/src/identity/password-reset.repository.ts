import { randomUUID } from 'node:crypto';
import { canonicalEmail } from './email-policy.js';
import { withPlatformTransaction } from '@pertexo/database/platform';
import {
  insertSystemMail,
  type SystemMailInput,
} from '@pertexo/secrets/server';
import { canonicalEmailSql } from './canonical-email.js';
import { and, eq, like, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import {
  authVerifications,
  authAccounts,
  users,
} from '@pertexo/database/schema';

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
    const {
      rows: [clock],
    } = await client.query<{ expiresAt: Date }>(
      `select clock_timestamp() + interval '1 hour' as "expiresAt"`,
    );
    if (clock === undefined) throw new Error('Database time unavailable');
    const recipient = { email: user.email, displayName: user.displayName };
    const prepared = input.prepareMail(recipient, clock.expiresAt);
    await db.insert(authVerifications).values({
      id: randomUUID(),
      identifier: `reset-password:${input.token}`,
      value: user.id,
      expiresAt: clock.expiresAt,
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    });
    if (prepared !== undefined) await insertSystemMail(client, prepared);
    return { recipient, queued: prepared !== undefined };
  });
}
