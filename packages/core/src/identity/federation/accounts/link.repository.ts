import { canonicalEmail } from '@pertexo/workflow-model';
import { authAccounts } from '@pertexo/database/schema';
import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { revokeUserSessions } from '../../../tenant-access/users/sessions.repository.js';
import { recordIdentitySecurityFact } from '../../facts.repository.js';
import { hasSignInMethodCapacity } from './limits.queries.js';

/**
 * Ties a provider's verified subject to the user a sign-in resolved, once, and
 * only when the address matches. Attaching a method revokes the user's other
 * sessions. False when this proof can't sign in as that user.
 */
export async function bindVerifiedAccount(
  client: PoolClient,
  {
    user,
    providerId,
    subject,
    email,
  }: Readonly<{
    user: Readonly<{ id: string; email: string }>;
    providerId: string;
    subject: string;
    email: string | null;
  }>,
): Promise<boolean> {
  // Membership commands and method removal lock the user before changing sessions.
  const [account] = await drizzle(client)
    .select({ user_id: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, providerId),
        eq(authAccounts.accountId, subject),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (account !== undefined) return account.user_id === user.id;
  if (!(await hasSignInMethodCapacity(client, user.id))) return false;
  if (email === null || canonicalEmail(email) !== canonicalEmail(user.email))
    return false;
  await drizzle(client)
    .insert(authAccounts)
    .values({
      id: generatePersistedId(),
      userId: user.id,
      providerId,
      accountId: subject,
    })
    .catch(rethrowQueryFailure);
  await revokeUserSessions(client, user.id);
  await recordIdentitySecurityFact(client, user.id, 'method.linked');
  return true;
}
