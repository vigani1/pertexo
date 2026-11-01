import { hasSignInMethodCapacity } from './federation/accounts/limits.queries.js';
import {
  prepareSessionChange,
  applySessionChange,
} from '../tenant-access/users/sessions.repository.js';
import type { AuthenticationReplacement } from '../tenant-access/users/contract.js';
import { isProtectedRecoveryOwner } from './federation/sessions/recovery.queries.js';
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import {
  databaseSchema,
  authAccounts,
  authSessions,
  authVerifications,
  users,
} from '@pertexo/database/schema';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { recordIdentitySecurityFact } from './facts.repository.js';

// A person changing their own sign-in methods, in no workspace: these stay off
// `withWorkspaceAccess`, which has no member to check.
export async function hasCredentialAccount(
  pool: Pool,
  userId: string,
): Promise<boolean> {
  const accounts = await drizzle(pool)
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, userId),
        eq(authAccounts.providerId, 'credential'),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return accounts.length !== 0;
}

/** Credential changes and revocation share one database commit. */
export async function changePasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{
    userId: string;
    currentPassword: string;
    newPasswordHash: string;
    verify: (hash: string, password: string) => Promise<boolean>;
    replacement?: AuthenticationReplacement;
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
    const sessionChange = await prepareSessionChange(
      client,
      input.userId,
      input.replacement,
    );
    if (sessionChange === undefined) return 'inactive';
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
    const passwordRefused =
      credential?.password === null ||
      credential?.password === undefined ||
      !(await input.verify(credential.password, input.currentPassword));
    if (passwordRefused) return 'invalid';
    await db
      .update(authAccounts)
      .set({
        password: input.newPasswordHash,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(authAccounts.id, credential.id));
    await applySessionChange(client, input.userId, sessionChange);
    await recordIdentitySecurityFact(client, input.userId, 'password.changed');
    return 'changed';
  }).catch(rethrowQueryFailure);
}

export async function setupPasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{
    userId: string;
    passwordHash: string;
    replacement?: AuthenticationReplacement;
  }>,
): Promise<'configured' | 'already' | 'unverified' | 'inactive' | 'limit'> {
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
    if (!(await hasSignInMethodCapacity(client, input.userId))) return 'limit';
    const sessionChange = await prepareSessionChange(
      client,
      input.userId,
      input.replacement,
    );
    if (sessionChange === undefined) return 'inactive';

    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: input.userId,
      providerId: 'credential',
      userId: input.userId,
      password: input.passwordHash,
    });
    await applySessionChange(client, input.userId, sessionChange);
    await recordIdentitySecurityFact(
      client,
      input.userId,
      'password.configured',
    );
    return 'configured';
  }).catch(rethrowQueryFailure);
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
  }).catch(rethrowQueryFailure);
}

/** The last sign-in method cannot be removed; removal revokes every session. */
export async function unlinkMethodAndRevokeSessions(
  pool: Pool,
  input: Readonly<{
    userId: string;
    methodId: string;
    replacement?: AuthenticationReplacement;
  }>,
): Promise<
  'unlinked' | 'last_method' | 'not_found' | 'protected_recovery' | 'inactive'
> {
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
    const sessionChange = await prepareSessionChange(
      client,
      input.userId,
      input.replacement,
    );
    if (sessionChange === undefined) return 'inactive';
    if (
      accounts.some(
        (account) =>
          account.id === input.methodId && account.providerId === 'credential',
      ) &&
      (await isProtectedRecoveryOwner(client, input.userId))
    )
      return 'protected_recovery';
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
    await applySessionChange(client, input.userId, sessionChange);
    await recordIdentitySecurityFact(client, input.userId, 'method.unlinked');
    return 'unlinked';
  }).catch(rethrowQueryFailure);
}
