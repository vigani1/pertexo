import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { users } from '../../../schema/foundation.js';
import { authAccounts } from '../../../schema/authentication.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import type { ProvenSocialSignIn } from '../contract.js';

const signInUser = {
  id: users.id,
  email: users.email,
  email_verified: users.emailVerified,
  status: users.status,
};
function userQuery(client: PoolClient) {
  return drizzle(client).select(signInUser).from(users);
}
type SignInUser = Awaited<ReturnType<typeof userQuery>>[number];

export async function resolveVerifiedSignInUser(
  client: PoolClient,
  input: Pick<ProvenSocialSignIn, 'provider' | 'identity'> &
    Readonly<{ createUser?: boolean }>,
): Promise<SignInUser | undefined> {
  const email = input.identity.email;
  if (email === null || !input.identity.emailVerified) return undefined;
  const normalizedEmail = email.toLowerCase();
  // Serializes first sign-in through different providers for the same address.
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`verified-sign-in:${normalizedEmail}`},0))`,
    )
    .catch(rethrowQueryFailure);
  const [linked] = await drizzle(client)
    .select({ user_id: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, input.provider),
        eq(authAccounts.accountId, input.identity.accountId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (linked !== undefined) {
    const [user] = await userQuery(client)
      .where(eq(users.id, linked.user_id))
      .for('update')
      .catch(rethrowQueryFailure);
    return user;
  }
  const [existing] = await userQuery(client)
    .where(sql`lower(${users.email})=lower(${normalizedEmail})`)
    .for('update')
    .catch(rethrowQueryFailure);
  if (existing !== undefined) return existing;
  if (input.createUser === false) return undefined;
  const [created] = await drizzle(client)
    .insert(users)
    .values({
      id: generatePersistedId(),
      email: normalizedEmail,
      emailVerified: true,
      displayName: input.identity.displayName,
      status: 'active',
    })
    .returning(signInUser)
    .catch(rethrowQueryFailure);
  return created;
}
