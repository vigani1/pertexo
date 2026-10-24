import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authSessions } from '../../schema/authentication.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { readEligibleAuthenticationSession } from '../../identity/federation/sessions/authority.js';
import type { SessionAuthenticationProof } from '../../identity/federation/sessions/policy.js';
import type { PoolClient } from 'pg';

import type { ReplacementSessionInput } from '../contract.js';

/**
 * Ends every Better Auth session of a user inside the caller's transaction,
 * so changed workspace authority cannot be exercised by a session issued
 * before the change.
 */
export function revokeUserSessions(
  client: PoolClient,
  userId: string,
): Promise<void> {
  return revokeSessionsForUsers(client, [userId]);
}

export async function revokeSessionsForUsers(
  client: PoolClient,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await drizzle(client)
    .delete(authSessions)
    .where(sql`${authSessions.userId}=any(${sql.param(userIds)}::uuid[])`)
    .catch(rethrowQueryFailure);
}

/**
 * Revokes every existing session of a user and installs the single Better
 * Auth session that replaces them, atomically with the caller's transaction,
 * so the browser that receives it is still signed in.
 */
export async function replaceUserSessions(
  client: PoolClient,
  userId: string,
  replacement: ReplacementSessionInput,
  proof: SessionAuthenticationProof,
): Promise<void> {
  await revokeUserSessions(client, userId);
  await drizzle(client)
    .insert(authSessions)
    .values({
      id: replacement.id,
      userId,
      token: replacement.token,
      expiresAt: replacement.expiresAt,
      userAgent: replacement.userAgent ?? null,
      ipAddress: replacement.ipAddress ?? null,
      authenticationMethod: proof.method,
      federationProviderId:
        proof.method === 'organization' ? proof.providerId : null,
      federationProviderRevision:
        proof.method === 'organization' ? proof.providerRevision : null,
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .catch(rethrowQueryFailure);
}

export type AuthenticationReplacement = ReplacementSessionInput &
  Readonly<{ sourceSessionId: string }>;
type SessionChange =
  | Readonly<{ kind: 'revoke' }>
  | Readonly<{
      kind: 'replace';
      session: AuthenticationReplacement;
      proof: SessionAuthenticationProof;
    }>;
/** Resolve the original session before revocation, inside the credential command's transaction. */
export async function prepareSessionChange(
  client: PoolClient,
  userId: string,
  replacement?: AuthenticationReplacement,
): Promise<SessionChange | undefined> {
  if (replacement === undefined) return { kind: 'revoke' };
  const source = await readEligibleAuthenticationSession(
    client,
    replacement.sourceSessionId,
  );
  return source?.userId === userId
    ? { kind: 'replace', session: replacement, proof: source.proof }
    : undefined;
}
export async function applySessionChange(
  client: PoolClient,
  userId: string,
  change: SessionChange,
): Promise<void> {
  if (change.kind === 'replace')
    await replaceUserSessions(client, userId, change.session, change.proof);
  else await revokeUserSessions(client, userId);
}
