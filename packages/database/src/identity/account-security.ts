import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { databaseSchema } from '../schema.js';
import {
  authAccounts,
  authSessions,
  authVerifications,
} from '../schema/authentication.js';
import { users } from '../schema/foundation.js';
import { withPlatformTransaction } from '../tenant-access/transactions.js';
import { rethrowIdentityQueryFailure } from './query-errors.js';
import { recordIdentitySecurityFact } from './security-facts.js';

/** Credential changes and revocation share one database commit. */
export async function changePasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{
    userId: string;
    currentPassword: string;
    newPasswordHash: string;
    verify: (hash: string, password: string) => Promise<boolean>;
  }>,
): Promise<'changed' | 'invalid' | 'inactive'> {
  return withPlatformTransaction(pool, async (client) => {
    const db = drizzle(client, { schema: databaseSchema });
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    if (user?.status !== 'active') return 'inactive';
    const [credential] = await db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, input.userId),
          eq(authAccounts.providerId, 'credential'),
        ),
      )
      .for('update');
    if (
      credential?.password === null ||
      credential?.password === undefined ||
      !(await input.verify(credential.password, input.currentPassword))
    )
      return 'invalid';
    await db
      .update(authAccounts)
      .set({
        password: input.newPasswordHash,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(authAccounts.id, credential.id));
    await db.delete(authSessions).where(eq(authSessions.userId, input.userId));
    await recordIdentitySecurityFact(client, input.userId, 'password.changed');
    return 'changed';
  }).catch(rethrowIdentityQueryFailure);
}

export async function setupPasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{ userId: string; passwordHash: string }>,
): Promise<'configured' | 'already' | 'unverified' | 'inactive'> {
  return withPlatformTransaction(pool, async (client) => {
    const db = drizzle(client, { schema: databaseSchema });
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    if (user?.status !== 'active') return 'inactive';
    if (!user.emailVerified) return 'unverified';
    const existing = await db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, input.userId),
          eq(authAccounts.providerId, 'credential'),
        ),
      )
      .for('update');
    if (existing.length !== 0) return 'already';
    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: input.userId,
      providerId: 'credential',
      userId: input.userId,
      password: input.passwordHash,
    });
    await db.delete(authSessions).where(eq(authSessions.userId, input.userId));
    await recordIdentitySecurityFact(
      client,
      input.userId,
      'password.configured',
    );
    return 'configured';
  }).catch(rethrowIdentityQueryFailure);
}

/** A reset token cannot create a credential method or survive a committed reset. */
export async function resetPasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{ token: string; passwordHash: string }>,
): Promise<'reset' | 'invalid'> {
  return withPlatformTransaction(pool, async (client) => {
    const db = drizzle(client, { schema: databaseSchema });
    const [proof] = await db
      .select()
      .from(authVerifications)
      .where(eq(authVerifications.identifier, `reset-password:${input.token}`))
      .orderBy(desc(authVerifications.createdAt), asc(authVerifications.id))
      .limit(1)
      .for('update');
    if (proof === undefined || proof.expiresAt.getTime() <= Date.now())
      return 'invalid';
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, proof.value))
      .for('update');
    if (user?.status !== 'active') return 'invalid';
    const [credential] = await db
      .select()
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, proof.value),
          eq(authAccounts.providerId, 'credential'),
        ),
      )
      .for('update');
    if (credential === undefined) return 'invalid';
    await db
      .update(authAccounts)
      .set({ password: input.passwordHash, updatedAt: sql`clock_timestamp()` })
      .where(eq(authAccounts.id, credential.id));
    await db.delete(authSessions).where(eq(authSessions.userId, proof.value));
    await db
      .delete(authVerifications)
      .where(eq(authVerifications.id, proof.id));
    await recordIdentitySecurityFact(client, proof.value, 'password.reset');
    return 'reset';
  }).catch(rethrowIdentityQueryFailure);
}

/** The last sign-in method cannot be removed; removal revokes every session. */
export async function unlinkMethodAndRevokeSessions(
  pool: Pool,
  input: Readonly<{ userId: string; methodId: string }>,
): Promise<'unlinked' | 'last_method' | 'not_found'> {
  return withPlatformTransaction(pool, async (client) => {
    const db = drizzle(client, { schema: databaseSchema });
    await db
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    const accounts = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, input.userId))
      .orderBy(asc(authAccounts.id))
      .for('update');
    if (accounts.length <= 1) return 'last_method';
    const removed = await db
      .delete(authAccounts)
      .where(
        and(
          eq(authAccounts.id, input.methodId),
          eq(authAccounts.userId, input.userId),
        ),
      )
      .returning({ id: authAccounts.id });
    if (removed.length !== 1) return 'not_found';
    await db.delete(authSessions).where(eq(authSessions.userId, input.userId));
    await recordIdentitySecurityFact(client, input.userId, 'method.unlinked');
    return 'unlinked';
  }).catch(rethrowIdentityQueryFailure);
}
