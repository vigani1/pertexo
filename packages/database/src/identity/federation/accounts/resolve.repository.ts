import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import type { ProvenSocialSignIn } from '../contract.js';

interface SignInUserRow {
  id: string;
  email: string;
  email_verified: boolean;
  status: string;
}

export async function resolveVerifiedSignInUser(
  client: PoolClient,
  input: Pick<ProvenSocialSignIn, 'provider' | 'identity'> &
    Readonly<{ createUser?: boolean }>,
): Promise<SignInUserRow | undefined> {
  const email = input.identity.email;
  if (email === null || !input.identity.emailVerified) return undefined;
  const normalizedEmail = email.toLowerCase();
  // Serializes first sign-in through different providers for the same address.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `verified-sign-in:${normalizedEmail}`,
  ]);
  const linked = (
    await client.query<{ user_id: string }>(
      'select user_id from app.auth_accounts where provider_id=$1 and account_id=$2',
      [input.provider, input.identity.accountId],
    )
  ).rows[0];
  if (linked !== undefined)
    return (
      await client.query<SignInUserRow>(
        'select id,email,email_verified,status from app.users where id=$1 for update',
        [linked.user_id],
      )
    ).rows[0];
  const existing = (
    await client.query<SignInUserRow>(
      'select id,email,email_verified,status from app.users where lower(email)=lower($1) for update',
      [normalizedEmail],
    )
  ).rows[0];
  if (existing !== undefined) return existing;
  if (input.createUser === false) return undefined;
  return (
    await client.query<SignInUserRow>(
      `insert into app.users(id,email,email_verified,display_name,status)
     values($1,$2,true,$3,'active') returning id,email,email_verified,status`,
      [generatePersistedId(), normalizedEmail, input.identity.displayName],
    )
  ).rows[0];
}
