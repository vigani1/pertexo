import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { revokeUserSessions } from '../../tenant-access/users/sessions.js';
import { recordIdentitySecurityFact } from '../security-facts.js';
import type { ProvenSocialSignIn, SocialSignInResult } from './contract.js';

interface SignInUserRow {
  id: string;
  email: string;
  email_verified: boolean;
  status: string;
}

async function resolveUser(
  client: PoolClient,
  input: ProvenSocialSignIn,
): Promise<SignInUserRow | undefined> {
  const email = input.identity.email;
  if (email === null || !input.identity.emailVerified) return undefined;
  const normalizedEmail = email.toLowerCase();
  // Serializes first sign-in through different providers for the same address.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `social-sign-in:${normalizedEmail}`,
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
  return (
    await client.query<SignInUserRow>(
      `insert into app.users(id,email,email_verified,display_name,status)
     values($1,$2,true,$3,'active') returning id,email,email_verified,status`,
      [generatePersistedId(), normalizedEmail, input.identity.displayName],
    )
  ).rows[0];
}

export async function completeSocialSignIn(
  client: PoolClient,
  input: ProvenSocialSignIn,
  sessionTtlSeconds: number,
): Promise<SocialSignInResult> {
  const attempt = (
    await client.query<{ return_path: string }>(
      `select return_path from app.auth_sign_in_attempts
     where id=$1 and provider=$2 and state_digest=$3 and browser_digest=$4
       and consumed_at is null and expires_at>clock_timestamp() for update`,
      [input.attemptId, input.provider, input.stateDigest, input.browserDigest],
    )
  ).rows[0];
  if (attempt === undefined) return { kind: 'failed' };
  const user = await resolveUser(client, input);
  if (user?.status !== 'active' || !user.email_verified)
    return { kind: 'failed' };
  // Membership commands and method removal lock the user before changing sessions.
  const account = (
    await client.query<{ user_id: string }>(
      'select user_id from app.auth_accounts where provider_id=$1 and account_id=$2 for update',
      [input.provider, input.identity.accountId],
    )
  ).rows[0];
  if (account !== undefined && account.user_id !== user.id)
    return { kind: 'failed' };
  if (account === undefined) {
    if (input.identity.email?.toLowerCase() !== user.email.toLowerCase())
      return { kind: 'failed' };
    await client.query(
      'insert into app.auth_accounts(id,user_id,provider_id,account_id) values($1,$2,$3,$4)',
      [
        generatePersistedId(),
        user.id,
        input.provider,
        input.identity.accountId,
      ],
    );
    await revokeUserSessions(client, user.id);
    await recordIdentitySecurityFact(client, user.id, 'method.linked');
  }
  const token = randomBytes(32).toString('base64url');
  await client.query(
    `insert into app.auth_sessions(id,user_id,token,expires_at)
     values($1,$2,$3,clock_timestamp()+($4::integer*interval '1 second'))`,
    [generatePersistedId(), user.id, token, sessionTtlSeconds],
  );
  await recordIdentitySecurityFact(client, user.id, 'session.signed_in');
  await client.query(
    'update app.auth_sign_in_attempts set consumed_at=clock_timestamp() where id=$1',
    [input.attemptId],
  );
  return { kind: 'signed_in', token, returnPath: attempt.return_path };
}
