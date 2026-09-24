import { generatePersistedId } from '../platform/persisted-id.js';

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema } from '../validation/persisted-primitives.js';
import { withPlatformTransaction } from './workspace.js';

import type {
  CreateSessionInput,
  IdentityWorkspaceDatabase,
  ReplacementSessionInput,
  SessionRecord,
} from './identity-workspace-contracts.js';
import {
  IdentityConflictError,
  IdentityNotFoundError,
} from './identity-workspace-errors.js';
import { mapSession } from './identity-workspace-rows.js';
import { readIdentityDatabaseErrorCode } from './identity-workspace-support.js';

const uuidSchema = z.uuid();
const digestSchema = sha256HexSchema;

type SessionStore = Pick<
  IdentityWorkspaceDatabase,
  | 'createSession'
  | 'findActiveSessionByDigest'
  | 'revokeSession'
  | 'revokeSessionByDigest'
>;

export function createIdentityWorkspaceSessionStore(pool: Pool): SessionStore {
  return Object.freeze({
    createSession: async (
      input: CreateSessionInput,
    ): Promise<SessionRecord> => {
      const id = uuidSchema.parse(input.id ?? generatePersistedId());
      const tokenDigest = digestSchema.parse(input.tokenDigest);
      const expiresAt: unknown = input.expiresAt;
      const expiryMillis =
        expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
      if (
        !(expiresAt instanceof Date) ||
        !Number.isFinite(expiryMillis) ||
        expiryMillis <= Date.now()
      )
        throw new Error('Session expiry must be in the future');
      try {
        const result = await pool.query(
          `insert into app.sessions
             (id, user_id, token_digest, expires_at, user_agent, ip_address)
           select $1, u.id, $3, $4, $5, $6
           from app.users u
           where u.id = $2 and u.status = 'active'
           returning id, user_id, token_digest, expires_at, revoked_at,
                     user_agent, ip_address, created_at`,
          [
            id,
            uuidSchema.parse(input.userId),
            tokenDigest,
            expiresAt,
            input.userAgent ?? null,
            input.ipAddress ?? null,
          ],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (row === undefined)
          throw new IdentityNotFoundError('User is not available');
        return mapSession(row);
      } catch (error: unknown) {
        if (error instanceof IdentityNotFoundError) throw error;
        const code = readIdentityDatabaseErrorCode(error);
        if (code === '23505' || code === '23503')
          throw new IdentityConflictError(
            'Session conflicts with an existing identity record',
            { cause: error },
          );
        throw error;
      }
    },
    findActiveSessionByDigest: async (
      tokenDigestInput: string,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<SessionRecord | null> => {
      const tokenDigest = digestSchema.parse(tokenDigestInput);
      return withPlatformTransaction(
        pool,
        async (client) => {
          const result = await client.query(
            `select s.id, s.user_id, s.token_digest, s.expires_at, s.revoked_at,
                s.user_agent, s.ip_address, s.created_at
         from app.sessions s
         join app.users u on u.id = s.user_id and u.status = 'active'
         where s.token_digest = $1 and s.revoked_at is null
           and s.expires_at > clock_timestamp()`,
            [tokenDigest],
          );
          const row = result.rows[0] as Record<string, unknown> | undefined;
          return row === undefined ? null : mapSession(row);
        },
        options,
      );
    },
    revokeSession: async (sessionIdInput: string): Promise<boolean> => {
      const result = await pool.query(
        `update app.sessions
         set revoked_at = coalesce(revoked_at, clock_timestamp())
         where id = $1 and revoked_at is null`,
        [uuidSchema.parse(sessionIdInput)],
      );
      return result.rowCount === 1;
    },
    revokeSessionByDigest: async (
      tokenDigestInput: string,
    ): Promise<boolean> => {
      const result = await pool.query(
        `update app.sessions
         set revoked_at = clock_timestamp()
         where token_digest = $1 and revoked_at is null`,
        [digestSchema.parse(tokenDigestInput)],
      );
      return result.rowCount === 1;
    },
  });
}

/**
 * Ends every browser session of a user inside the caller's transaction, both
 * legacy OIDC sessions and Better Auth sessions, so changed workspace
 * authority cannot be exercised by a session issued before the change.
 */
export async function revokeUserSessions(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `update app.sessions set revoked_at=coalesce(revoked_at,clock_timestamp())
      where user_id=$1 and revoked_at is null`,
    [userId],
  );
  await client.query(`delete from app.auth_sessions where user_id=$1`, [
    userId,
  ]);
}

/**
 * Revokes every existing session of a user and installs the single session
 * that replaces them, atomically with the caller's transaction. The
 * replacement is written to the store of the active session authority so the
 * browser that receives it is still signed in.
 */
export async function replaceUserSessions(
  client: PoolClient,
  userId: string,
  replacement: ReplacementSessionInput,
): Promise<void> {
  await revokeUserSessions(client, userId);
  const metadata = [
    replacement.userAgent ?? null,
    replacement.ipAddress ?? null,
  ];
  if (replacement.authority === 'opaque') {
    await client.query(
      `insert into app.sessions
         (id,user_id,token_digest,expires_at,user_agent,ip_address)
       values($1,$2,$3,$4,$5,$6)`,
      [
        uuidSchema.parse(replacement.id),
        userId,
        digestSchema.parse(replacement.tokenDigest),
        replacement.expiresAt,
        ...metadata,
      ],
    );
    return;
  }
  await client.query(
    `insert into app.auth_sessions
       (id,user_id,token,expires_at,user_agent,ip_address,created_at,updated_at)
     values($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp())`,
    [
      replacement.id,
      userId,
      replacement.token,
      replacement.expiresAt,
      ...metadata,
    ],
  );
}
