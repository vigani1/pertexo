import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authSignInAttempts } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { bindVerifiedAccount } from '../accounts/link.repository.js';
import { resolveVerifiedSignInUser } from '../accounts/resolve.repository.js';
import { canCreateAuthenticationSession } from '../sessions/authority.repository.js';
import { issueSession } from '../sessions/issue.repository.js';
import type { PoolClient } from 'pg';
import { recordIdentitySecurityFact } from '../../facts.repository.js';
import { admitNewAccount, type SignUpMode } from '../../sign-up.js';
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
  if (
    !(await bindVerifiedAccount(client, {
      user,
      providerId: input.provider,
      subject: input.identity.accountId,
      email: input.identity.email,
    }))
  )
    return { kind: 'failed' };
  const token = await issueSession(client, user.id, sessionTtlSeconds, {
    method: 'social',
  });
  await recordIdentitySecurityFact(client, user.id, 'session.signed_in');
  await db
    .update(authSignInAttempts)
    .set({ consumedAt: sql`clock_timestamp()` })
    .where(eq(authSignInAttempts.id, input.attemptId))
    .catch(rethrowQueryFailure);
  return { kind: 'signed_in', token, returnPath: attempt.return_path };
}
