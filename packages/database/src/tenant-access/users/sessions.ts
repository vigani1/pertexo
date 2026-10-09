import type { PoolClient } from 'pg';

import type { ReplacementSessionInput } from '../contracts.js';

/**
 * Ends every Better Auth session of a user inside the caller's transaction,
 * so changed workspace authority cannot be exercised by a session issued
 * before the change.
 */
export async function revokeUserSessions(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(`delete from app.auth_sessions where user_id=$1`, [
    userId,
  ]);
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
): Promise<void> {
  await revokeUserSessions(client, userId);
  await client.query(
    `insert into app.auth_sessions
       (id,user_id,token,expires_at,user_agent,ip_address,created_at,updated_at)
     values($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp())`,
    [
      replacement.id,
      userId,
      replacement.token,
      replacement.expiresAt,
      replacement.userAgent ?? null,
      replacement.ipAddress ?? null,
    ],
  );
}
