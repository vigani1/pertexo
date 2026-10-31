import { canonicalEmail } from '@pertexo/workflow-model';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authSignInAttempts } from '../../schema/identity/sign-in.js';
import { authAccounts, authSessions } from '../../schema/authentication.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { hasSignInMethodCapacity } from './accounts/limits.queries.js';
import { resolveVerifiedSignInUser } from './accounts/resolve.repository.js';
import { canCreateAuthenticationSession } from './sessions/authority.repository.js';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { revokeUserSessions } from '../../tenant-access/users/sessions.repository.js';
import { recordIdentitySecurityFact } from '../facts.repository.js';
import { admitNewAccount, type SignUpMode } from '../sign-up.js';
import type { ProvenSocialSignIn, SocialSignInResult } from './contract.js';

export async function completeSocialSignIn(
  client: PoolClient,
  input: ProvenSocialSignIn,
  {
    sessionTtlSeconds,
    signUpMode,
  }: Readonly<{ sessionTtlSeconds: number; signUpMode: SignUpMode }>,
): Promise<SocialSignInResult> {
  const db = drizzle(client);
  const [attempt] = await db
    .select({ return_path: authSignInAttempts.returnPath })
    .from(authSignInAttempts)
    .where(
      and(
        eq(authSignInAttempts.id, input.attemptId),
        eq(authSignInAttempts.provider, input.provider),
        eq(authSignInAttempts.stateDigest, input.stateDigest),
        eq(authSignInAttempts.browserDigest, input.browserDigest),
        isNull(authSignInAttempts.consumedAt),
        gt(authSignInAttempts.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (attempt === undefined) return { kind: 'failed' };
  const user = await resolveVerifiedSignInUser(client, {
    ...input,
    mayCreateUser: () =>
      admitNewAccount(client, signUpMode, input.identity.email ?? ''),
  });
  if (user?.status !== 'active' || !user.email_verified)
    return { kind: 'failed' };
  if (
    !(await canCreateAuthenticationSession(client, user.id, {
      method: 'social',
    }))
  )
    return { kind: 'failed' };
  // Membership commands and method removal lock the user before changing sessions.
  const [account] = await db
    .select({ user_id: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, input.provider),
        eq(authAccounts.accountId, input.identity.accountId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (account !== undefined && account.user_id !== user.id)
    return { kind: 'failed' };
  if (account === undefined) {
    if (!(await hasSignInMethodCapacity(client, user.id)))
      return { kind: 'failed' };
    if (
      input.identity.email === null ||
      canonicalEmail(input.identity.email) !== canonicalEmail(user.email)
    )
      return { kind: 'failed' };
    await db
      .insert(authAccounts)
      .values({
        id: generatePersistedId(),
        userId: user.id,
        providerId: input.provider,
        accountId: input.identity.accountId,
      })
      .catch(rethrowQueryFailure);
    await revokeUserSessions(client, user.id);
    await recordIdentitySecurityFact(client, user.id, 'method.linked');
  }
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(authSessions)
    .values({
      id: generatePersistedId(),
      userId: user.id,
      token,
      expiresAt: sql`clock_timestamp()+(${sessionTtlSeconds}::integer*interval '1 second')`,
      authenticationMethod: 'social',
    })
    .catch(rethrowQueryFailure);
  await recordIdentitySecurityFact(client, user.id, 'session.signed_in');
  await db
    .update(authSignInAttempts)
    .set({ consumedAt: sql`clock_timestamp()` })
    .where(eq(authSignInAttempts.id, input.attemptId))
    .catch(rethrowQueryFailure);
  return { kind: 'signed_in', token, returnPath: attempt.return_path };
}
